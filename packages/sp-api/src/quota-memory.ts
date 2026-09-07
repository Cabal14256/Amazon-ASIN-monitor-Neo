import { SpApiError } from './errors';
import type { QuotaWindow } from './quota-policy';

interface Bucket {
  limit: number;
  rate: number;
  tokens: number;
  updatedAt: number;
}
export interface QuotaDecision {
  allowed: boolean;
  retryMs: number;
}

/** All windows are checked before any deduction, including a shared region. */
export class QuotaMemory {
  private readonly buckets = new Map<string, Bucket>();
  constructor(private readonly maxKeys = 32) {
    if (!Number.isInteger(maxKeys) || maxKeys < 1 || maxKeys > 1000)
      throw new SpApiError('INVALID_CONFIG');
  }
  private prepare(windows: readonly QuotaWindow[], now: number) {
    if (!windows.length || !Number.isFinite(now) || now < 0 || now > 8.64e15)
      throw new SpApiError('INVALID_INPUT');
    const keys = new Set<string>();
    for (const window of windows) {
      if (
        typeof window.key !== 'string' ||
        !window.key ||
        window.key.length > 512 ||
        keys.has(window.key) ||
        !Number.isInteger(window.limit) ||
        window.limit < 1 ||
        window.limit > 1_000_000 ||
        !Number.isFinite(window.rate) ||
        window.rate <= 0 ||
        window.rate > 1_000_000
      )
        throw new SpApiError('INVALID_INPUT');
      keys.add(window.key);
    }
    if (
      this.buckets.size +
        [...keys].filter((key) => !this.buckets.has(key)).length >
      this.maxKeys
    )
      throw new SpApiError('CAPACITY');
    return windows.map((window) => {
      let bucket = this.buckets.get(window.key);
      if (!bucket) {
        bucket = {
          limit: window.limit,
          rate: window.rate,
          tokens: window.limit,
          updatedAt: now,
        };
        this.buckets.set(window.key, bucket);
      } else {
        bucket.tokens = Math.min(
          bucket.limit,
          bucket.tokens +
            (Math.max(now - bucket.updatedAt, 0) * bucket.rate) / 1000,
        );
        bucket.updatedAt = Math.max(now, bucket.updatedAt);
        // Preserve consumed debt even if a new response header shrinks capacity
        // below it. A later increase must not silently refill the whole bucket.
        bucket.tokens += window.limit - bucket.limit;
        bucket.limit = window.limit;
        bucket.rate = window.rate;
      }
      return { window, bucket };
    });
  }
  private evaluate(
    windows: readonly QuotaWindow[],
    now: number,
    tokens: number,
  ) {
    if (
      !Number.isInteger(tokens) ||
      tokens < 1 ||
      windows.some((window) => tokens > window.limit)
    )
      throw new SpApiError('INVALID_INPUT');
    const entries = this.prepare(windows, now);
    const retryMs = Math.max(
      0,
      ...entries.map(({ bucket }) =>
        Math.ceil(((tokens - bucket.tokens) / bucket.rate) * 1000),
      ),
    );
    return { entries, decision: { allowed: retryMs === 0, retryMs } };
  }
  probe(
    windows: readonly QuotaWindow[],
    now: number,
    tokens = 1,
  ): QuotaDecision {
    return this.evaluate(windows, now, tokens).decision;
  }
  consume(
    windows: readonly QuotaWindow[],
    now: number,
    tokens = 1,
  ): QuotaDecision {
    const { entries, decision } = this.evaluate(windows, now, tokens);
    if (decision.allowed)
      for (const { bucket } of entries) bucket.tokens -= tokens;
    return decision;
  }
  snapshot(windows: readonly QuotaWindow[], now: number) {
    return this.prepare(windows, now).map(({ window, bucket }) => ({
      ...window,
      remaining: Math.max(bucket.tokens, 0),
      used: Math.max(bucket.limit - bucket.tokens, 0),
    }));
  }
}
