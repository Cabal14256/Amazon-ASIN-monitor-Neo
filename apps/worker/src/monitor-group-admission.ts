import type { Env } from '@asin-monitor/config';
import type { SpApiConfigurationRow } from '@asin-monitor/db';
import { SpApiError, type SpApiRiskController } from '@asin-monitor/sp-api';
import type { VariantGroupAdmission } from '@asin-monitor/variant-check';
import { logger } from './logger';

const MAX_WAITERS = 100;
const MAX_CHECKPOINTS = 16;
const POLL_INTERVAL_MS = 1000;
const CONFIG_POLL_MS = 5000;
const CONFIG_TIMEOUT_MS = 2000;
const WAIT_TIMEOUT_MS = 30_000;
type Waiter = {
  signal: AbortSignal;
  checkpoint(): Promise<void>;
  resolve(release: () => void): void;
  reject(error: unknown): void;
  abort(): void;
  timer: ReturnType<typeof setTimeout>;
  checking: boolean;
  ready: boolean;
};

/** One runtime shares this across both monitor queues; replicas have their own
 * gates. Pipeline work owns permits through physical settlement, including I/O
 * that returns after its caller has already observed cancellation. */
export class MonitorGroupAdmission implements VariantGroupAdmission {
  private readonly waiters: Waiter[] = [];
  private active = 0;
  private checkpoints = 0;
  private limit = 1;
  private configured: number | undefined;
  private failed = true;
  private failures = 0;
  private nextRefreshAt = 0;
  private reader: Promise<void> | undefined;
  private refreshResult: Promise<void> | undefined;
  private readerController: AbortController | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private checks: ReturnType<typeof setInterval> | undefined;
  private closed = false;
  constructor(
    private readonly env: Pick<
      Env,
      | 'MONITOR_MAX_CONCURRENT_GROUP_CHECKS'
      | 'MAX_ALLOWED_CONCURRENT_GROUP_CHECKS'
      | 'AUTO_ADJUST_CONCURRENCY'
    >,
    private readonly readConfiguration: (
      signal: AbortSignal,
    ) => Promise<SpApiConfigurationRow[]>,
    private readonly risk: Pick<
      SpApiRiskController,
      'setCurrentConcurrency' | 'calculateOptimalConcurrency'
    >,
  ) {}
  private cap(value: number) {
    return Math.min(
      8,
      this.env.MAX_ALLOWED_CONCURRENT_GROUP_CHECKS,
      Math.max(1, Math.floor(value)),
    );
  }
  getDiagnostics() {
    return {
      active: this.active,
      waiting: this.waiters.length,
      limit: this.limit,
      pendingConfiguration: !!this.reader,
      pendingCheckpoints: this.checkpoints,
      closed: this.closed,
    };
  }
  async start(): Promise<void> {
    if (this.closed) throw new SpApiError('CLOSED');
    if (this.poll) return this.refreshResult;
    this.poll = setInterval(() => void this.refresh(), POLL_INTERVAL_MS);
    this.poll.unref();
    this.checks = setInterval(() => {
      for (const waiter of this.waiters) this.validate(waiter);
    }, POLL_INTERVAL_MS);
    this.checks.unref();
    await this.refresh();
  }
  refresh(): Promise<void> {
    if (this.closed || performance.now() < this.nextRefreshAt)
      return Promise.resolve();
    if (this.reader) return this.refreshResult!;
    const controller = new AbortController();
    this.readerController = controller;
    let ignored = false;
    const failure = () => {
      if (ignored || this.closed) return;
      ignored = true;
      controller.abort();
      this.failed = true;
      this.limit = 1;
      this.failures++;
      this.nextRefreshAt =
        performance.now() +
        Math.min(30_000, CONFIG_POLL_MS * 2 ** Math.min(3, this.failures - 1));
      logger.warn('Monitor group configuration unavailable; using one group', {
        reason: 'monitor_group_configuration_unavailable',
      });
      this.pump();
    };
    let completeDeadline!: () => void;
    const deadline = new Promise<void>((resolve) => {
      completeDeadline = resolve;
    });
    const timer = setTimeout(() => {
      failure();
      completeDeadline();
    }, CONFIG_TIMEOUT_MS);
    timer.unref();
    this.reader = Promise.resolve()
      .then(() => this.readConfiguration(controller.signal))
      .then((rows) => {
        if (ignored || this.closed || controller.signal.aborted) return;
        if (!Array.isArray(rows) || rows.length > 200)
          throw new SpApiError('INVALID_CONFIG');
        const values = rows.filter(
          (row) =>
            row.configKey.toUpperCase() ===
            'MONITOR_MAX_CONCURRENT_GROUP_CHECKS',
        );
        if (
          values.length > 1 ||
          (values.length &&
            (typeof values[0].configValue !== 'string' ||
              !/^[1-9]\d*$/.test(values[0].configValue) ||
              !Number.isSafeInteger(Number(values[0].configValue))))
        )
          throw new SpApiError('INVALID_CONFIG');
        const configured = this.cap(
          values.length
            ? Number(values[0].configValue)
            : this.env.MONITOR_MAX_CONCURRENT_GROUP_CHECKS,
        );
        if (this.failed || configured !== this.configured) {
          this.limit = configured;
          this.risk.setCurrentConcurrency(configured);
        }
        this.configured = configured;
        this.failed = false;
        this.failures = 0;
        this.nextRefreshAt = performance.now() + CONFIG_POLL_MS;
        this.pump();
      })
      .catch(failure)
      .finally(() => {
        clearTimeout(timer);
        this.reader = undefined;
        this.readerController = undefined;
      });
    // The deadline releases the waiter, never the actual configuration I/O slot.
    this.refreshResult = Promise.race([this.reader, deadline]);
    return this.refreshResult;
  }
  acquire(
    signal: AbortSignal,
    checkpoint: () => Promise<void>,
  ): Promise<() => void> {
    if (this.closed) return Promise.reject(new SpApiError('CLOSED'));
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.waiters.length >= MAX_WAITERS)
      return Promise.reject(new SpApiError('CAPACITY'));
    if (!this.failed && this.env.AUTO_ADJUST_CONCURRENCY) {
      const optimal = this.risk.calculateOptimalConcurrency(this.limit);
      this.limit =
        Number.isFinite(optimal) && optimal > 0 ? this.cap(optimal) : 1;
    }
    return new Promise<() => void>((resolve, reject) => {
      const abort = () =>
        this.remove(waiter, signal.reason ?? new SpApiError('CANCELLED'));
      const timer = setTimeout(
        () => this.remove(waiter, new SpApiError('TIMEOUT')),
        WAIT_TIMEOUT_MS,
      );
      timer.unref();
      const waiter: Waiter = {
        signal,
        checkpoint,
        resolve,
        reject,
        abort,
        timer,
        checking: false,
        ready: false,
      };
      this.waiters.push(waiter);
      signal.addEventListener('abort', abort, { once: true });
      this.validate(waiter);
    });
  }
  private remove(waiter: Waiter, error?: unknown, pump = true) {
    const index = this.waiters.indexOf(waiter);
    if (index < 0) return;
    this.waiters.splice(index, 1);
    waiter.signal.removeEventListener('abort', waiter.abort);
    clearTimeout(waiter.timer);
    if (error !== undefined) waiter.reject(error);
    if (pump) this.pump();
  }
  private validate(waiter: Waiter) {
    if (waiter.checking || this.closed || this.checkpoints >= MAX_CHECKPOINTS)
      return;
    waiter.ready = false;
    waiter.checking = true;
    this.checkpoints++;
    void Promise.resolve()
      .then(() => {
        waiter.signal.throwIfAborted();
        return waiter.checkpoint();
      })
      .then(() => {
        if (
          !this.closed &&
          !waiter.signal.aborted &&
          this.waiters.includes(waiter)
        )
          waiter.ready = true;
      })
      .catch((error: unknown) => this.remove(waiter, error))
      .finally(() => {
        waiter.checking = false;
        this.checkpoints--;
        this.pump();
      });
  }
  private pump() {
    if (this.closed) return;
    while (this.active < this.limit && this.waiters[0]?.ready) {
      const waiter = this.waiters[0];
      this.active++;
      this.remove(waiter, undefined, false);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        this.pump();
      });
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.poll) clearInterval(this.poll);
    if (this.checks) clearInterval(this.checks);
    this.readerController?.abort();
    for (const waiter of [...this.waiters])
      this.remove(waiter, new SpApiError('CLOSED'));
  }
}
