import { abortError, SpApiError } from './errors';
import type { Priority } from './types';

export interface CatalogCheckLimits {
  concurrency?: number;
  maxQueued?: number;
  maxWaiters?: number;
  timeoutMs?: number;
}
interface Waiter<T> {
  resolve(value: T): void;
  reject(error: unknown): void;
  detach(): void;
}
interface Work<T> {
  key: string;
  priority: Priority;
  controller: AbortController;
  waiters: Set<Waiter<T>>;
  run(signal: AbortSignal, priority: Priority): Promise<T>;
  started: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/** Bounded admission for complete checks (cache, flags, upstream and deferred
 * writes). A disconnected caller releases only its subscription. The underlying
 * slot stays occupied until actual work settles, even if an adapter ignores abort.
 * Returned values must be immutable because duplicate callers share one result.
 */
export class CatalogCheckScheduler<T> {
  private readonly concurrency: number;
  private readonly maxQueued: number;
  private readonly maxWaiters: number;
  private readonly timeoutMs: number;
  private readonly active = new Set<Work<T>>();
  private readonly queue: Work<T>[] = [];
  private readonly latest = new Map<string, Work<T>>();
  private waiters = 0;
  private closed = false;
  constructor(limits: CatalogCheckLimits = {}) {
    this.concurrency = limits.concurrency ?? 3;
    this.maxQueued = limits.maxQueued ?? 128;
    this.maxWaiters = limits.maxWaiters ?? 256;
    this.timeoutMs = limits.timeoutMs ?? 300_000;
    for (const [value, min, max] of [
      [this.concurrency, 1, 64],
      [this.maxQueued, 0, 1024],
      [this.maxWaiters, 1, 1024],
      [this.timeoutMs, 1, 900_000],
    ]) {
      if (!Number.isInteger(value) || value < min || value > max)
        throw new SpApiError('INVALID_CONFIG');
    }
  }
  async run(
    key: string,
    priority: Priority,
    forceRefresh: boolean,
    signal: AbortSignal | undefined,
    run: Work<T>['run'],
  ): Promise<T> {
    if (this.closed) throw new SpApiError('CLOSED');
    if (signal?.aborted) throw new SpApiError('CANCELLED');
    if (this.waiters >= this.maxWaiters) throw new SpApiError('CAPACITY');
    let work = forceRefresh ? undefined : this.latest.get(key);
    if (work?.controller.signal.aborted) work = undefined;
    if (!work) {
      if (
        this.active.size >= this.concurrency &&
        this.queue.length >= this.maxQueued
      )
        throw new SpApiError('CAPACITY');
      work = {
        key,
        priority,
        controller: new AbortController(),
        waiters: new Set(),
        started: false,
        run,
        // Joining callers cannot prolong one real check indefinitely.
        timer: setTimeout(() => this.expire(selected), 900_000),
      };
      this.latest.set(key, work);
      this.queue.push(work);
    } else if (!work.started && priority < work.priority) {
      work.priority = priority;
    }
    const selected = work;
    return new Promise<T>((resolve, reject) => {
      const abort = () => leave(new SpApiError('CANCELLED'));
      const timer = setTimeout(
        () => leave(new SpApiError('TIMEOUT')),
        this.timeoutMs,
      );
      const waiter: Waiter<T> = {
        resolve,
        reject,
        detach: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', abort);
          selected.waiters.delete(waiter);
          this.waiters--;
        },
      };
      const leave = (error: SpApiError) => {
        if (!selected.waiters.has(waiter)) return;
        waiter.detach();
        reject(error);
        if (!selected.waiters.size) {
          clearTimeout(selected.timer);
          selected.controller.abort(error);
          if (this.latest.get(key) === selected) this.latest.delete(key);
          if (!selected.started) {
            const index = this.queue.indexOf(selected);
            if (index >= 0) this.queue.splice(index, 1);
          }
        }
      };
      selected.waiters.add(waiter);
      this.waiters++;
      signal?.addEventListener('abort', abort, { once: true });
      this.drain();
    });
  }
  private drain(): void {
    while (
      !this.closed &&
      this.active.size < this.concurrency &&
      this.queue.length
    ) {
      // Stable priority ordering; a joined manual caller promotes queued work.
      let index = 0;
      for (let i = 1; i < this.queue.length; i++)
        if (this.queue[i].priority < this.queue[index].priority) index = i;
      const work = this.queue.splice(index, 1)[0];
      work.started = true;
      this.active.add(work);
      void Promise.resolve()
        .then(() => {
          if (work.controller.signal.aborted)
            throw abortError(work.controller.signal);
          return work.run(work.controller.signal, work.priority);
        })
        .then(
          (value) => this.finish(work, { value }),
          (error: unknown) => this.finish(work, { error }),
        );
    }
  }
  private finish(work: Work<T>, result: { value: T } | { error: unknown }) {
    clearTimeout(work.timer);
    for (const waiter of [...work.waiters]) {
      waiter.detach();
      if ('error' in result) waiter.reject(result.error);
      else waiter.resolve(result.value);
    }
    this.active.delete(work);
    if (this.latest.get(work.key) === work) this.latest.delete(work.key);
    this.drain();
  }
  private expire(work: Work<T>): void {
    const error = new SpApiError('TIMEOUT');
    work.controller.abort(error);
    for (const waiter of [...work.waiters]) {
      waiter.detach();
      waiter.reject(error);
    }
    if (this.latest.get(work.key) === work) this.latest.delete(work.key);
    if (!work.started) {
      const index = this.queue.indexOf(work);
      if (index >= 0) this.queue.splice(index, 1);
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const work of [...this.active, ...this.queue]) {
      clearTimeout(work.timer);
      const error = new SpApiError('CLOSED');
      work.controller.abort(error);
      for (const waiter of [...work.waiters]) {
        waiter.detach();
        waiter.reject(error);
      }
    }
    this.queue.length = 0;
    this.latest.clear();
  }
}
