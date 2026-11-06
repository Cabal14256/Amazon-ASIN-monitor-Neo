import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AnalyticsCacheClearBudget,
  AnalyticsCacheClearDeadlineError,
  analyticsCacheGenerationKey,
  isAnalyticsCacheGeneration,
  newAnalyticsCacheGeneration,
  parseAnalyticsCacheCapture,
} from '../src/monitor/monitor-analytics-cache-control';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('analytics clear generation and shared monotonic budget', () => {
  it('uses fresh 256-bit generations and a literal control key outside data SCAN', () => {
    const generations = Array.from({ length: 10 }, newAnalyticsCacheGeneration);
    expect(new Set(generations).size).toBe(10);
    expect(generations.every(isAnalyticsCacheGeneration)).toBe(true);
    expect(analyticsCacheGenerationKey('  literal[*]  ')).toBe(
      'literal[*]:neo:ops:analytics-cache:generation',
    );
    expect(isAnalyticsCacheGeneration('a'.repeat(65))).toBe(false);
    expect(isAnalyticsCacheGeneration('A'.repeat(64))).toBe(false);
  });
  it('rejects malformed capture tuples, unsafe time and unbounded control data', () => {
    const token = 'a'.repeat(64);
    for (const value of [
      null,
      [token],
      [token, '1', 'extra'],
      ['x'.repeat(2 * 1024 * 1024), '1'],
      [token, 1],
      [token, '-1'],
      [token, '1e3'],
      [token, '9007199254740992'],
    ])
      expect(parseAnalyticsCacheCapture(value)).toBeNull();
    expect(parseAnalyticsCacheCapture([token, '100000'])).toEqual({
      generation: token,
      serverTime: 100000,
    });
  });
  it('deducts slow capture and ACK time before freezing the server deadline', async () => {
    let localNow = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => localNow);
    const budget = new AnalyticsCacheClearBudget();
    const capture = await budget.run(async () => {
      localNow = 4500;
      return ['a'.repeat(64), '100000'];
    });
    const parsed = parseAnalyticsCacheCapture(capture)!;
    const fixed = budget.fixedServerDeadline(parsed.serverTime);
    expect(fixed).toBe(100500);
    localNow = 4900;
    await budget.run(async () => 'scan');
    expect(fixed).toBe(100500);
    expect(budget.remaining()).toBe(100);
  });
  it('rejects an ACK received after the original deadline even when its timer has not fired', async () => {
    vi.useFakeTimers();
    let localNow = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => localNow);
    const budget = new AnalyticsCacheClearBudget();
    let release!: () => void;
    const pending = budget.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const observed = pending.catch((error: unknown) => error);
    await Promise.resolve();
    localNow = 5001;
    release();
    expect(await observed).toBeInstanceOf(AnalyticsCacheClearDeadlineError);
    const next = vi.fn(async () => undefined);
    await expect(budget.run(next)).rejects.toBeInstanceOf(
      AnalyticsCacheClearDeadlineError,
    );
    expect(next).not.toHaveBeenCalled();
  });
  it('rejects caller timeout without pretending to cancel underlying work', async () => {
    vi.useFakeTimers();
    vi.spyOn(performance, 'now').mockReturnValue(0);
    const budget = new AnalyticsCacheClearBudget();
    let settle!: () => void;
    const executed = vi.fn();
    const observed = budget
      .run(
        () =>
          new Promise<void>((resolve) => {
            settle = () => {
              executed();
              resolve();
            };
          }),
      )
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await observed).toBeInstanceOf(AnalyticsCacheClearDeadlineError);
    expect(executed).not.toHaveBeenCalled();
    settle();
    await Promise.resolve();
    expect(executed).toHaveBeenCalledOnce();
  });
});
