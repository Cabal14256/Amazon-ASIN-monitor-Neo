import { SpApiError } from './errors';

export const safeCount = (count: number, extra = 1) =>
  Math.min(Number.MAX_SAFE_INTEGER, count + extra);
export class TelemetryClock {
  private last = 0;
  constructor(private readonly source: () => number = Date.now) {
    if (typeof source !== 'function') throw new SpApiError('INVALID_CONFIG');
  }
  now() {
    const value = this.source();
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > 8_640_000_000_000_000
    )
      throw new SpApiError('INVALID_INPUT');
    this.last = Math.max(this.last, value);
    return this.last;
  }
}
/** Fixed 3,601 second buckets. Include the cutoff second conservatively: counts
 * may retain an event for less than one extra second, but never forget an event
 * still inside the hour. Volume cannot grow memory or suppress a risk threshold. */
export class HourlyCounter {
  private readonly seconds = new Float64Array(3601).fill(-1);
  private readonly counts = new Float64Array(3601);
  record(now: number) {
    const second = Math.floor(now / 1000),
      slot = second % 3601;
    if (this.seconds[slot] !== second) {
      this.seconds[slot] = second;
      this.counts[slot] = 0;
    }
    this.counts[slot] = safeCount(this.counts[slot]);
  }
  count(now: number) {
    const current = Math.floor(now / 1000),
      cutoff = current - 3600;
    let result = 0;
    for (let i = 0; i < this.seconds.length; i++)
      if (
        this.seconds[i] >= cutoff &&
        this.seconds[i] <= current &&
        this.seconds[i] !== -1
      )
        result = safeCount(result, this.counts[i]);
    return result;
  }
  reset() {
    this.seconds.fill(-1);
    this.counts.fill(0);
  }
}
export function validateWindow(size: number, max: number) {
  if (!Number.isInteger(size) || size < 1 || size > max)
    throw new SpApiError('INVALID_INPUT');
}
