import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifySpApiError,
  SpApiErrorStatistics,
} from '../src/error-statistics';
import { SpApiError } from '../src/errors';
import { SpApiRiskController } from '../src/risk-controller';
import { HourlyCounter, safeCount } from '../src/telemetry-window';

const logger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});
afterEach(() => vi.restoreAllMocks());
describe('SP-API telemetry safety and bounded windows', () => {
  it('does not create timers when constructing, observing, calculating or resetting', () => {
    const interval = vi.spyOn(globalThis, 'setInterval'),
      timeout = vi.spyOn(globalThis, 'setTimeout');
    const risk = new SpApiRiskController({ logger: logger() });
    const stats = new SpApiErrorStatistics({ logger: logger() });
    risk.recordCheck({ success: true });
    risk.calculateOptimalConcurrency(2);
    risk.resetMetrics();
    stats.recordErrorAuto(new Error('fixture'));
    stats.resetStats();
    expect(interval).not.toHaveBeenCalled();
    expect(timeout).not.toHaveBeenCalled();
  });
  it.each([undefined, null, {}, { statusCode: 401 }, { message: 42 }])(
    'classifies missing/non-string messages without throwing: %j',
    (error) => {
      expect(classifySpApiError(error)).toBe(
        error && 'statusCode' in error ? 'AUTH_ERROR' : 'UNKNOWN',
      );
    },
  );
  it('prefers structured status/codes and retains no upstream diagnostic fields', () => {
    const output = logger(),
      stats = new SpApiErrorStatistics({ logger: output });
    const error = {
      statusCode: 401,
      message: '429 fixture-private-secret',
      authorization: 'fixture-private-secret',
      url: 'https://invalid.example/fixture-private-secret',
    };
    expect(classifySpApiError(error)).toBe('AUTH_ERROR');
    expect(
      classifySpApiError(new SpApiError('HTTP_ERROR', 400, ['QuotaExceeded'])),
    ).toBe('RATE_LIMIT');
    expect(classifySpApiError(new SpApiError('TIMEOUT'))).toBe('TIMEOUT');
    expect(classifySpApiError(new SpApiError('HTTP_ERROR', 502))).toBe(
      'SERVER_ERROR',
    );
    stats.recordErrorAuto(error);
    expect(stats.getErrorStats().timeSeries[0]).toMatchObject({
      type: 'AUTH_ERROR',
      statusCode: 401,
      message: 'SP-API AUTH_ERROR',
    });
    expect(
      JSON.stringify([
        stats.getErrorStats(),
        output.info.mock.calls,
        output.error.mock.calls,
      ]),
    ).not.toContain('fixture-private-secret');
  });
  it('ignores hostile diagnostic getters and never converts arbitrary code objects to strings', () => {
    const hostile = Object.defineProperty({}, 'statusCode', {
      get() {
        throw new Error('private-getter');
      },
    });
    const toString = vi.fn(() => 'network');
    expect(classifySpApiError(hostile)).toBe('UNKNOWN');
    expect(classifySpApiError({ code: { toString } })).toBe('UNKNOWN');
    expect(toString).not.toHaveBeenCalled();
    const stats = new SpApiErrorStatistics({ logger: logger() });
    stats.recordErrorAuto(hostile);
    expect(stats.getErrorStats().total).toBe(1);
  });
  it('expires error history on reads, applies all filters consistently and fills recent counts', () => {
    let now = 10000;
    const stats = new SpApiErrorStatistics({
      logger: logger(),
      now: () => now,
    });
    stats.recordError('RATE_LIMIT', 'US');
    stats.recordError('RATE_LIMIT', 'EU');
    stats.recordError('TIMEOUT', 'EU');
    const result = stats.getErrorStats({ region: 'EU', type: 'RATE_LIMIT' });
    expect(result.recent).toEqual({
      count: 1,
      hours: 1,
      byType: { RATE_LIMIT: 1 },
      byRegion: { EU: 1 },
    });
    expect(result.timeSeries.map((row) => [row.region, row.type])).toEqual([
      ['EU', 'RATE_LIMIT'],
    ]);
    now += 3_600_000;
    expect(stats.getErrorStats().recent.count).toBe(0);
    expect(stats.getErrorStats().total).toBe(3);
  });
  it('returned snapshots and caller input cannot mutate counters or risk calculations', () => {
    const stats = new SpApiErrorStatistics({ logger: logger() });
    stats.recordError('RATE_LIMIT');
    const result = stats.getErrorStats();
    result.byType.RATE_LIMIT.count = 900;
    result.byType.RATE_LIMIT.recentWindow.length = 0;
    result.byRegion.US.RATE_LIMIT.count = 900;
    result.timeSeries[0].type = 'TIMEOUT';
    expect(stats.getErrorStats().byType.RATE_LIMIT.count).toBe(1);
    expect(stats.getErrorStats().byType.RATE_LIMIT.recentWindow).toHaveLength(
      1,
    );
    expect(stats.getErrorStats().byRegion.US.RATE_LIMIT.count).toBe(1);
    expect(stats.getErrorStats().timeSeries[0].type).toBe('RATE_LIMIT');
    const input = { success: true, responseTime: 1 };
    const risk = new SpApiRiskController({ logger: logger() });
    risk.recordCheck(input);
    input.success = false;
    input.responseTime = 90;
    expect(risk.getMetrics()).toMatchObject({
      errorRate: '0.000',
      avgResponseTime: '1.00',
    });
  });
  it('keeps hourly counts under a large burst without retaining one allocation per error, and expires on idle reads', () => {
    let now = 1_000_123;
    const risk = new SpApiRiskController({ logger: logger(), now: () => now });
    for (let i = 0; i < 100_000; i++)
      risk.recordCheck({
        isRateLimit: true,
        isSpApiError: true,
        responseTime: 1,
      });
    expect(risk.getMetrics()).toMatchObject({
      rateLimitCount: 100000,
      totalRateLimitErrors: 100000,
      totalSpApiErrors: 100000,
      recentChecksCount: 100,
    });
    now += 3_600_000;
    expect(risk.getRecentRateLimitCount()).toBe(100000); // Conservative cutoff-second bucket.
    now += 1000;
    expect(risk.getRecentRateLimitCount()).toBe(0);
    expect(risk.getMetrics().totalRateLimitErrors).toBe(100000);
    // Assert the storage bound directly: changing volume cannot silently truncate counts.
    const counter = (
      risk as unknown as {
        rateLimits: { seconds: Float64Array; counts: Float64Array };
      }
    ).rateLimits;
    expect(counter.seconds.length).toBe(3601);
    expect(counter.counts.length).toBe(3601);
  });
  it('wraps second buckets without reviving old events, bounds counters and resets state', () => {
    const counter = new HourlyCounter();
    counter.record(0);
    counter.record(0);
    counter.record(3_601_000);
    expect(counter.count(3_601_000)).toBe(1);
    expect(counter.count(9_000_000)).toBe(0);
    counter.reset();
    expect(counter.count(3_601_000)).toBe(0);
    expect(safeCount(Number.MAX_SAFE_INTEGER - 1, 50)).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
  it('does not increase concurrency with no check samples, respects configured bounds and leaves no cross-instance state', () => {
    const first = new SpApiRiskController({
      logger: logger(),
      maxConcurrency: 3,
    });
    const second = new SpApiRiskController({ logger: logger() });
    expect(first.calculateOptimalConcurrency(2)).toBe(2);
    first.recordCheck({ success: true, responseTime: 1 });
    expect(first.calculateOptimalConcurrency(3)).toBe(3);
    first.recordCheck({ isRateLimit: true });
    expect(second.getMetrics().totalRateLimitErrors).toBe(0);
    first.resetMetrics();
    expect(first.getMetrics()).toMatchObject({
      recentChecksCount: 0,
      totalSuccessfulChecks: 0,
      totalRateLimitErrors: 0,
      lastRateLimitAt: null,
    });
  });
  it('clock rollback cannot expire throttles or bypass adjustment cooldown', () => {
    let now = 10_000_000;
    const risk = new SpApiRiskController({ logger: logger(), now: () => now });
    for (let i = 0; i < 6; i++) risk.recordCheck({ isRateLimit: true });
    expect(risk.calculateOptimalConcurrency(4)).toBe(3);
    now -= 3_600_000;
    expect(risk.getRecentRateLimitCount()).toBe(6);
    expect(risk.calculateOptimalConcurrency(3)).toBe(3);
    now = 10_299_999;
    expect(risk.calculateOptimalConcurrency(3)).toBe(3);
    now++;
    expect(risk.calculateOptimalConcurrency(3)).toBe(2);
  });
  it.each([0, -1, NaN, Infinity, 1001])(
    'rejects invalid maximum concurrency %s',
    (maxConcurrency) => {
      expect(
        () => new SpApiRiskController({ logger: logger(), maxConcurrency }),
      ).toThrow('INVALID_CONFIG');
    },
  );
  it('rejects unbounded or malformed query/check inputs and validates clocks before mutation', () => {
    const stats = new SpApiErrorStatistics({
      logger: logger(),
      now: () => NaN,
    });
    expect(() => stats.recordError('UNKNOWN')).toThrow('INVALID_INPUT');
    const risk = new SpApiRiskController({ logger: logger() });
    for (const input of [
      { responseTime: Infinity },
      { responseTime: -1 },
      { responseTime: 86401 },
      { success: 'yes' },
    ])
      expect(() => risk.recordCheck(input as never)).toThrow('INVALID_INPUT');
    expect(risk.getMetrics().recentChecksCount).toBe(0);
    const valid = new SpApiErrorStatistics({ logger: logger() });
    expect(() => valid.getErrorStats(null as never)).toThrow('INVALID_INPUT');
    expect(() => valid.getErrorStats([] as never)).toThrow('INVALID_INPUT');
    for (const hours of [0, -1, NaN, Infinity, 169])
      expect(() => valid.getErrorStats({ hours })).toThrow('INVALID_INPUT');
    expect(() => valid.recordError('constructor' as never)).toThrow(
      'INVALID_INPUT',
    );
    expect(() => valid.recordError('UNKNOWN', 'DE' as never)).toThrow(
      'INVALID_INPUT',
    );
    expect(() => valid.getErrorRate(1001)).toThrow('INVALID_INPUT');
    expect(() => risk.getRecentErrorRate(101)).toThrow('INVALID_INPUT');
    expect(() => risk.getAverageResponseTime(0)).toThrow('INVALID_INPUT');
    expect(() => risk.setCurrentConcurrency(Infinity)).toThrow('INVALID_INPUT');
  });
});
