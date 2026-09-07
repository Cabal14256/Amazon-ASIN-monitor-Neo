import { randomUUID } from 'node:crypto';
import { abortError, SpApiError } from './errors';
import { QuotaMemory, type QuotaDecision } from './quota-memory';
import {
  buildQuotaWindows,
  DEFAULT_QUOTA_SETTINGS,
  isQuotaOperation,
  OPERATION_QUOTAS,
  resolveQuotaSettings,
  type QuotaMetadata,
  type QuotaOperation,
  type QuotaSettings,
  type QuotaWindow,
} from './quota-policy';
import { RedisQuotaStore, type QuotaRedisPort } from './quota-redis';
import type {
  AttemptContext,
  Logger,
  QuotaExecutor,
  Region,
  ResponseMetadata,
} from './types';

type Mode = 'memory' | 'redis-distributed';
interface Group {
  region: Region;
  operation: QuotaOperation;
  active: number;
  blockedUntil: number;
  metadata?: QuotaMetadata;
  dirty?: QuotaMetadata;
  publishing: boolean;
  lastMode: Mode;
}
interface Job {
  id: string;
  group: Group;
  context: AttemptContext;
  task: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: SpApiError) => void;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  abort: () => void;
  state: 'queued' | 'running' | 'done';
  stopped?: SpApiError;
}
export interface SpApiQuotaOptions {
  logger: Logger;
  settings?: QuotaSettings;
  redis?: QuotaRedisPort;
  redisTimeoutMs?: number;
  now?: () => number;
  /** Waiting/acquiring jobs across all six operation groups; default 1000. */
  maxPending?: number;
  /** Queue time only. Running requests retain their slot until they settle. */
  maxWaitMs?: number;
  /** Optional reduction of Legacy's per-operation concurrency (2/2/1). */
  concurrency?: 1 | 2;
}

/** Single atomic admission pump, bounded queues, and continuous local shadow
 * consumption. Redis and Legacy share account quota keys; memory fallback is
 * process-local and cannot coordinate independent instances during an outage.
 */
export class SpApiQuotaExecutor implements QuotaExecutor {
  readonly settings: QuotaSettings;
  private readonly store?: RedisQuotaStore;
  private readonly memory = new QuotaMemory();
  private readonly groups = new Map<string, Group>();
  private readonly regionalMode = new Map<Region, Mode>();
  private readonly waiting: Job[] = [];
  private readonly running = new Set<Job>();
  private readonly maxPending: number;
  private readonly maxWaitMs: number;
  private readonly concurrency: number;
  private readonly clock: () => number;
  private health: 'unknown' | 'ready' | 'failed' = 'unknown';
  private pumping = false;
  private rerun = false;
  private closed = false;
  private wake?: ReturnType<typeof setTimeout>;
  constructor(private readonly options: SpApiQuotaOptions) {
    this.maxPending = options.maxPending ?? 1000;
    this.maxWaitMs = options.maxWaitMs ?? 120_000;
    this.concurrency = options.concurrency ?? 2;
    this.clock = options.now ?? Date.now;
    if (
      !Number.isInteger(this.maxPending) ||
      this.maxPending < 1 ||
      this.maxPending > 1000 ||
      !Number.isInteger(this.maxWaitMs) ||
      this.maxWaitMs < 1 ||
      this.maxWaitMs > 900_000 ||
      ![1, 2].includes(this.concurrency) ||
      typeof this.clock !== 'function' ||
      typeof options.logger?.warn !== 'function' ||
      typeof options.logger?.info !== 'function'
    )
      throw new SpApiError('INVALID_CONFIG');
    const settings = options.settings ?? DEFAULT_QUOTA_SETTINGS;
    this.settings = resolveQuotaSettings({
      RATE_LIMITER_KEY_PREFIX: settings.prefix,
      SP_API_RATE_LIMIT_PER_MINUTE: settings.regionPerMinute,
      SP_API_RATE_LIMIT_PER_HOUR: settings.regionPerHour,
      SP_API_RATE_LIMIT_SAFETY_FACTOR: settings.safetyFactor,
      SP_API_RATE_LIMIT_BURST_CAP: settings.burstCap,
    });
    if (options.redis)
      this.store = new RedisQuotaStore(options.redis, this.settings, {
        timeoutMs: options.redisTimeoutMs,
        now: this.clock,
      });
    for (const region of ['US', 'EU'] as const) {
      this.regionalMode.set(region, 'memory');
      for (const operation of Object.keys(OPERATION_QUOTAS) as QuotaOperation[])
        this.groups.set(`${region}:${operation}`, {
          region,
          operation,
          active: 0,
          blockedUntil: 0,
          publishing: false,
          lastMode: 'memory',
        });
    }
  }
  private now() {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0 || now > 253402300799999)
      throw new SpApiError('DEPENDENCY_ERROR');
    return now;
  }
  private group(region: Region, operation: string) {
    if (!['US', 'EU'].includes(region) || !isQuotaOperation(operation))
      throw new SpApiError('INVALID_INPUT');
    return this.groups.get(`${region}:${operation}`)!;
  }
  private windows(group: Group) {
    return buildQuotaWindows(
      this.settings,
      group.region,
      group.operation,
      group.metadata,
    );
  }
  private remember(group: Group, metadata?: QuotaMetadata) {
    if (!metadata) return;
    if (
      group.metadata?.updatedAt &&
      (!metadata.updatedAt || group.metadata.updatedAt > metadata.updatedAt)
    )
      return;
    group.metadata = { ...metadata };
  }
  private log(level: 'info' | 'warn', message: string, reason?: string) {
    // Diagnostics must never alter delivery or expose driver/config payloads.
    try {
      this.options.logger[level](message, reason ? { reason } : undefined);
    } catch {
      /* caller-owned logger */
    }
  }
  private redisHealth(ready: boolean, reason?: string) {
    if (ready) {
      if (this.health === 'failed') this.log('info', 'SP-API 分布式配额已恢复');
      this.health = 'ready';
    } else {
      if (this.health !== 'failed')
        this.log('warn', 'SP-API 配额降级为进程内存', reason);
      this.health = 'failed';
    }
  }
  execute<T>(context: AttemptContext, task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.closed) throw new SpApiError('CLOSED');
      const group = this.group(context.region, context.operation);
      if (
        ![1, 2, 3].includes(context.priority) ||
        !(context.signal instanceof AbortSignal) ||
        typeof task !== 'function'
      )
        throw new SpApiError('INVALID_INPUT');
      if (context.signal.aborted) throw abortError(context.signal);
      if (this.waiting.length >= this.maxPending)
        throw new SpApiError('CAPACITY');
      const job: Job = {
        id: randomUUID(),
        group,
        context: { ...context },
        task,
        resolve: (value) => resolve(value as T),
        reject,
        controller: new AbortController(),
        abort: () => {},
        state: 'queued',
      };
      job.abort = () => this.stop(job, abortError(job.context.signal));
      context.signal.addEventListener('abort', job.abort, { once: true });
      job.timer = setTimeout(
        () => this.stop(job, new SpApiError('TIMEOUT')),
        this.maxWaitMs,
      );
      this.waiting.push(job);
      // Stable sorting keeps FIFO order within each priority, including retries
      // of admission. A running callback is never put back into this queue.
      this.waiting.sort((a, b) => a.context.priority - b.context.priority);
      this.kick();
    });
  }
  private remove(job: Job) {
    const index = this.waiting.indexOf(job);
    if (index >= 0) this.waiting.splice(index, 1);
  }
  private cleanup(job: Job) {
    clearTimeout(job.timer);
    job.context.signal.removeEventListener('abort', job.abort);
    job.state = 'done';
  }
  private stop(job: Job, error: SpApiError) {
    if (job.state === 'done' || job.stopped) return;
    job.stopped = error;
    job.controller.abort(error);
    if (job.state === 'queued') {
      this.remove(job);
      this.cleanup(job);
      job.reject(error);
      this.kick();
    }
    // For running jobs, execute must await actual work. SpApiClient provides
    // prompt caller cancellation separately while preserving its own admission.
  }
  private capacity(group: Group) {
    return Math.min(this.concurrency, OPERATION_QUOTAS[group.operation].burst);
  }
  private kick() {
    if (this.closed) return;
    if (this.pumping) {
      this.rerun = true;
      return;
    }
    clearTimeout(this.wake);
    this.wake = undefined;
    this.pumping = true;
    void this.pump().finally(() => {
      this.pumping = false;
      if (this.rerun) {
        this.rerun = false;
        this.kick();
      } else this.schedule();
    });
  }
  private schedule() {
    if (this.closed || !this.waiting.length) return;
    const candidates = this.waiting.filter(
      (job) => job.group.active < this.capacity(job.group),
    );
    if (!candidates.length) return; // Completion wakes queues blocked by concurrency.
    let now: number;
    try {
      now = this.now();
    } catch {
      for (const job of [...this.waiting])
        this.stop(job, new SpApiError('DEPENDENCY_ERROR'));
      return;
    }
    const delay = Math.max(
      25,
      Math.min(5000, ...candidates.map((job) => job.group.blockedUntil - now)),
    );
    this.wake = setTimeout(() => {
      this.wake = undefined;
      this.kick();
    }, delay);
  }
  private async admission(job: Job): Promise<QuotaDecision & { mode: Mode }> {
    const group = job.group;
    let local = this.memory.probe(this.windows(group), this.now());
    if (!local.allowed) return { ...local, mode: 'memory' };
    if (this.store) {
      this.flushObservation(group);
      const result = await this.store.acquire(
        group.region,
        group.operation,
        job.id,
        job.controller.signal,
        (metadata) => {
          this.remember(group, metadata);
          return this.memory.probe(this.windows(group), this.now());
        },
      );
      if (job.stopped || this.closed)
        throw job.stopped ?? new SpApiError('CLOSED');
      if (result.available) {
        if (result.value.checkedRedis !== false) this.redisHealth(true);
        if (!result.value.allowed)
          return { ...result.value, mode: 'redis-distributed' };
        local = this.memory.consume(this.windows(group), this.now());
        // A newer observation may have lowered capacity during the Lua await.
        // The unused Redis charge is conservative; no callback has run yet.
        return { ...local, mode: 'redis-distributed' };
      }
      if (['cancelled', 'closed'].includes(result.reason))
        throw new SpApiError('CANCELLED');
      if (result.reason === 'busy' && this.health !== 'failed')
        return { allowed: false, retryMs: 25, mode: 'redis-distributed' };
      if (result.reason !== 'busy') this.redisHealth(false, result.reason);
    }
    return {
      ...this.memory.consume(this.windows(group), this.now()),
      mode: 'memory',
    };
  }
  private async pump() {
    while (!this.closed) {
      let job: Job | undefined;
      try {
        const now = this.now();
        job = this.waiting.find(
          (candidate) =>
            candidate.group.active < this.capacity(candidate.group) &&
            candidate.group.blockedUntil <= now,
        );
        if (!job) return;
        const decision = await this.admission(job);
        if (job.state !== 'queued' || job.stopped || this.closed) continue;
        if (!decision.allowed) {
          // Infinity from extremely small valid header rates must never become
          // a Node timer overflow / busy loop. Every job still has a deadline.
          job.group.blockedUntil =
            this.now() + Math.max(25, Math.min(5000, decision.retryMs));
          continue;
        }
        this.remove(job);
        clearTimeout(job.timer);
        job.state = 'running';
        job.group.active++;
        job.group.lastMode = decision.mode;
        this.regionalMode.set(job.group.region, decision.mode);
        this.running.add(job);
        this.start(job);
      } catch (error) {
        const safe =
          error instanceof SpApiError
            ? error
            : new SpApiError('DEPENDENCY_ERROR');
        if (job) this.stop(job, safe);
        else {
          for (const waiting of [...this.waiting]) this.stop(waiting, safe);
          return;
        }
      }
    }
  }
  private start(job: Job) {
    const work = Promise.resolve().then(() => {
      if (job.stopped || job.context.signal.aborted || this.closed)
        throw job.stopped ?? new SpApiError('CANCELLED');
      return job.task();
    });
    const finish = (value: unknown, error?: unknown) => {
      this.running.delete(job);
      job.group.active--;
      const failed =
        job.stopped ??
        (error instanceof SpApiError
          ? error
          : error === undefined
          ? undefined
          : new SpApiError('DEPENDENCY_ERROR'));
      this.cleanup(job);
      if (failed) job.reject(failed);
      else job.resolve(value);
      this.kick();
    };
    void work.then(
      (value) => finish(value),
      (error: unknown) =>
        finish(undefined, error ?? new SpApiError('DEPENDENCY_ERROR')),
    );
  }
  observe(metadata: ResponseMetadata): void {
    if (this.closed) return;
    const group = this.group(metadata.region, metadata.operation);
    const rate = metadata.rateLimit;
    if (rate === undefined) return;
    if (!Number.isFinite(rate) || rate <= 0 || rate > 1_000_000)
      throw new SpApiError('INVALID_INPUT');
    const observed = {
      rate,
      burst: OPERATION_QUOTAS[group.operation].burst,
      updatedAt: new Date(this.now()).toISOString(),
    };
    this.remember(group, observed);
    if (group.metadata?.updatedAt === observed.updatedAt)
      group.dirty = observed;
    group.blockedUntil = 0;
    this.flushObservation(group);
    this.kick();
  }
  private flushObservation(group: Group) {
    if (this.closed || !this.store || !group.dirty || group.publishing) return;
    const metadata = group.dirty;
    group.publishing = true;
    // Coalesce to at most one in-flight write and one latest record per group.
    // A failed write is retried on a later observation/admission, never by
    // replaying the Amazon request or accumulating a background retry queue.
    void this.store
      .publish(
        group.region,
        group.operation,
        metadata.rate,
        undefined,
        Date.parse(metadata.updatedAt!),
      )
      .then(
        (result) => {
          if (result.available && group.dirty === metadata)
            group.dirty = undefined;
          group.publishing = false;
          if (result.available && group.dirty) this.flushObservation(group);
        },
        () => {
          group.publishing = false;
        },
      );
  }
  /** Effective capacity: the stricter of shared Redis usage and this process's
   * continuous shadow. A recovered Redis connection cannot hide fallback debt.
   * The shape matches the existing rateLimiterSnapshot contract.
   */
  async snapshot(region: Region, operation?: string, signal?: AbortSignal) {
    if (this.closed) throw new SpApiError('CLOSED');
    if (signal?.aborted) throw abortError(signal);
    const group = this.group(region, operation ?? 'default');
    if (operation !== undefined) this.flushObservation(group);
    const remote = await this.store?.snapshot(region, operation, signal);
    if (this.closed) throw new SpApiError('CLOSED');
    if (signal?.aborted) throw abortError(signal);
    if (remote?.available && operation !== undefined)
      this.remember(group, remote.value.metadata);
    const all = this.windows(group);
    const selected = operation === undefined ? all.slice(0, 2) : all.slice(2);
    const local = this.memory.snapshot(selected, this.now());
    const effective = local.map((window) => {
      const shared = remote?.available
        ? remote.value.windows.find((item) => item.key === window.key)
        : undefined;
      if (!shared) return window;
      const limit = Math.min(window.limit, shared.limit);
      // Capacities may differ while a header update is being published. Combine
      // signed free capacity first, so used/remaining describe the same limit
      // and negative free capacity still exposes outstanding consumption debt.
      const free = Math.min(
        window.limit - window.used,
        shared.limit - shared.used,
      );
      return {
        ...window,
        limit,
        remaining: Math.max(free, 0),
        used: limit - free,
      };
    });
    const minute = effective.find((window) => window.windowMs === 60_000)!;
    const hour = effective.find((window) => window.windowMs === 3_600_000)!;
    const second = effective.find((window) => window.windowMs === 1000);
    const usage = ({
      used,
      remaining,
      limit,
      windowMs,
    }: QuotaWindow & { used: number; remaining: number }) => ({
      used,
      remaining,
      limit,
      windowMs,
    });
    const metadata = operation === undefined ? undefined : group.metadata;
    return {
      mode: remote?.available ? 'redis-distributed' : 'memory',
      lastMode:
        operation === undefined
          ? this.regionalMode.get(region)!
          : group.lastMode,
      redisAvailable: remote?.available === true,
      name: `${region}:${
        operation === undefined ? 'region' : `operation:${operation}`
      }`,
      secondTokens: second?.remaining ?? null,
      minuteTokens: minute.remaining,
      hourTokens: hour.remaining,
      limits: {
        second: second?.limit ?? null,
        minute: minute.limit,
        hour: hour.limit,
      },
      windows: {
        ...(second ? { second: usage(second) } : {}),
        minute: usage(minute),
        hour: usage(hour),
      },
      limitSource: metadata ? 'response_header' : 'default',
      limitUpdatedAt: metadata?.updatedAt ?? null,
    };
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.wake);
    for (const job of [...this.waiting, ...this.running])
      this.stop(job, new SpApiError('CLOSED'));
    this.store?.close();
  }
}
