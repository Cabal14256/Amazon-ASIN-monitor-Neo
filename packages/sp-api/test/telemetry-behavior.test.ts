import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { SpApiErrorStatistics } from '../src/error-statistics';
import { SpApiRiskController } from '../src/risk-controller';

const logger = () => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
});
interface LegacyRisk {
  recordCheck(input: object): void;
  getMetrics(): object;
  calculateOptimalConcurrency(current: number): number;
  resetMetrics(): void;
}
interface LegacyErrors {
  classifyError(error: unknown): string;
  recordErrorAuto(error: unknown, region: string): void;
  getErrorStats(options?: object): {
    total: number;
    byType: object;
    byRegion: object;
    recent: { count: number };
    timeSeries: unknown[];
  };
  getErrorRate(size?: number): object;
}
function legacy<T>(file: string, now: () => number) {
  const module = { exports: {} as T };
  class FixtureDate extends Date {
    constructor(value: number | string = now()) {
      super(value);
    }
    static now() {
      return now();
    }
  }
  runInNewContext(
    readFileSync(
      resolve(__dirname, '../../../server/src/services', file),
      'utf8',
    ),
    {
      module,
      Date: FixtureDate,
      process: { env: {} },
      require: (name: string) => {
        if (name !== '../utils/logger')
          throw new Error('Unexpected telemetry fixture dependency');
        return logger();
      },
      setInterval: vi.fn(() => 1),
      clearInterval: vi.fn(),
    },
  );
  return module.exports;
}
const json = (value: unknown) => JSON.parse(JSON.stringify(value));

describe('SP-API telemetry / actual Legacy behavior fixtures', () => {
  it.each([
    [429, 'QuotaExceeded', 'RATE_LIMIT'],
    [401, 'Unauthorized', 'AUTH_ERROR'],
    [403, 'Forbidden', 'FORBIDDEN'],
    [404, 'NotFound', 'NOT_FOUND'],
    [400, 'Bad Request', 'INVALID_INPUT'],
    [500, 'Internal Server Error', 'SERVER_ERROR'],
    [503, 'Service Unavailable', 'SERVER_ERROR'],
    [undefined, 'ECONNRESET', 'NETWORK_ERROR'],
    [undefined, 'request timeout', 'TIMEOUT'],
    [undefined, 'unclassified fixture', 'UNKNOWN'],
  ] as const)(
    'preserves the supported Legacy classification %s %s',
    (statusCode, message, expected) => {
      const old = legacy<LegacyErrors>('errorStatsService.js', Date.now);
      const stats = new SpApiErrorStatistics({ logger: logger() });
      const error = { statusCode, message };
      expect(old.classifyError(error)).toBe(expected);
      expect(stats.classifyError(error)).toBe(expected);
    },
  );
  it('preserves bounded global/region totals and windows while replacing raw diagnostic messages', () => {
    let now = Date.UTC(2026, 8, 7);
    const old = legacy<LegacyErrors>('errorStatsService.js', () => now);
    const stats = new SpApiErrorStatistics({
      logger: logger(),
      now: () => now,
    });
    for (let i = 0; i < 1105; i++) {
      now += 10;
      const error = {
        statusCode: i % 2 ? 429 : 500,
        message: 'private-fixture-message',
      };
      const region = i % 3 ? 'US' : 'EU';
      old.recordErrorAuto(error, region);
      stats.recordErrorAuto(error, region);
    }
    const previous = old.getErrorStats(),
      result = stats.getErrorStats();
    expect(result.total).toBe(previous.total);
    expect(json(result.byType)).toEqual(json(previous.byType));
    expect(json(result.byRegion)).toEqual(json(previous.byRegion));
    expect(result.recent.count).toBe(previous.recent.count);
    expect(result.timeSeries).toHaveLength(100);
    expect(JSON.stringify(result)).not.toContain('private-fixture-message');
    expect(stats.getErrorRate()).toEqual(json(old.getErrorRate()));
  });
  it('preserves the 100-check / 50-check error-rate and response-time calculations', () => {
    let now = Date.UTC(2026, 8, 7);
    const old = legacy<LegacyRisk>('riskControlService.js', () => now);
    const risk = new SpApiRiskController({ logger: logger(), now: () => now });
    for (let i = 0; i < 120; i++) {
      now += 1000;
      const input = {
        success: i % 4 !== 0,
        isRateLimit: i % 17 === 0,
        isSpApiError: i % 11 === 0,
        responseTime: (i % 5) / 2,
      };
      old.recordCheck(input);
      risk.recordCheck(input);
    }
    expect(risk.getMetrics()).toEqual(json(old.getMetrics()));
    expect(risk.getRecentErrorRate(50)).toBeCloseTo(0.4, 1);
  });
  it.each([
    { failures: 16, limits: 0, seconds: 1, expected: 2 },
    { failures: 15, limits: 0, seconds: 1, expected: 3 },
    { failures: 0, limits: 6, seconds: 1, expected: 2 },
    { failures: 0, limits: 5, seconds: 1, expected: 3 },
    { failures: 4, limits: 0, seconds: 1, expected: 4 },
    { failures: 5, limits: 0, seconds: 1, expected: 3 },
    { failures: 0, limits: 0, seconds: 2, expected: 3 },
  ])(
    'preserves concurrency thresholds for %j',
    ({ failures, limits, seconds, expected }) => {
      const now = () => Date.UTC(2026, 8, 7);
      const old = legacy<LegacyRisk>('riskControlService.js', now);
      const risk = new SpApiRiskController({ logger: logger(), now });
      for (let i = 0; i < 50; i++) {
        const input = {
          success: i >= failures,
          isRateLimit: i < limits,
          responseTime: seconds,
        };
        old.recordCheck(input);
        risk.recordCheck(input);
      }
      expect(old.calculateOptimalConcurrency(3)).toBe(expected);
      expect(risk.calculateOptimalConcurrency(3)).toBe(expected);
    },
  );
  it('preserves five-minute adjustment cooldown, one-step changes and default ceiling', () => {
    let now = Date.UTC(2026, 8, 7);
    const old = legacy<LegacyRisk>('riskControlService.js', () => now);
    const risk = new SpApiRiskController({ logger: logger(), now: () => now });
    old.recordCheck({ success: true, responseTime: 1 });
    risk.recordCheck({ success: true, responseTime: 1 });
    for (const [current, elapsed, expected] of [
      [8, 0, 9],
      [9, 299999, 9],
      [9, 1, 10],
      [10, 300000, 10],
    ]) {
      now += elapsed;
      expect(old.calculateOptimalConcurrency(current)).toBe(expected);
      expect(risk.calculateOptimalConcurrency(current)).toBe(expected);
    }
  });
});
