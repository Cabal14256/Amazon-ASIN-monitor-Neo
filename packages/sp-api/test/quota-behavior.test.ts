import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildQuotaWindows,
  DEFAULT_QUOTA_SETTINGS,
  operationLimits,
  parseQuotaMetadata,
  resolveQuotaSettings,
} from '../src/quota-policy';

const legacyRequire = createRequire(__filename);
let legacy: {
  DEFAULT_OPERATION_CONFIGS: Record<
    string,
    { rate: number; burst: number; perMinute: number; perHour: number }
  >;
  getSafeOperationLimits(
    config: unknown,
    rate?: number,
  ): { effectiveRate: number; perMinute: number; perHour: number };
  getOperationBurstLimit(burst: number): number;
};
beforeEach(() => {
  vi.stubEnv('LOG_LEVEL', 'ERROR');
  vi.stubEnv('SP_API_RATE_LIMIT_SAFETY_FACTOR', '');
  vi.stubEnv('SP_API_RATE_LIMIT_BURST_CAP', '');
  legacy = legacyRequire('../../../server/src/services/rateLimiter.js');
});
afterEach(() => vi.unstubAllEnvs());

describe('Migrated Legacy quota policy before executor implementation', () => {
  it('preserves the regional 45/minute and 2700/hour cap without applying operation safety twice', () => {
    expect(DEFAULT_QUOTA_SETTINGS).toMatchObject({
      regionPerMinute: 45,
      regionPerHour: 2700,
      safetyFactor: 0.75,
    });
    const windows = buildQuotaWindows(
      DEFAULT_QUOTA_SETTINGS,
      'US',
      'getCatalogItem',
    );
    expect(
      windows.map((window) => [window.key, window.limit, window.windowMs]),
    ).toEqual([
      ['spapi:ratelimiter:US:region:minute', 45, 60000],
      ['spapi:ratelimiter:US:region:hour', 2700, 3600000],
      ['spapi:ratelimiter:US:operation:getCatalogItem:second', 1, 1000],
      ['spapi:ratelimiter:US:operation:getCatalogItem:minute', 90, 60000],
      ['spapi:ratelimiter:US:operation:getCatalogItem:hour', 5400, 3600000],
    ]);
  });
  it.each(['getCatalogItem', 'searchCatalogItems', 'default'])(
    'matches Legacy safe operation limits for %s',
    (operation) => {
      const config = legacy.DEFAULT_OPERATION_CONFIGS[operation]!;
      expect(operationLimits(DEFAULT_QUOTA_SETTINGS, operation)).toEqual({
        ...legacy.getSafeOperationLimits(config),
        burst: legacy.getOperationBurstLimit(config.burst),
      });
    },
  );
  it.each([0.1, 1, 1.5, 10])(
    'applies header rate %s with the same upper caps and safety factor as Legacy',
    (rate) => {
      const config = legacy.DEFAULT_OPERATION_CONFIGS.getCatalogItem!;
      expect(
        operationLimits(DEFAULT_QUOTA_SETTINGS, 'getCatalogItem', {
          rate,
          burst: 4,
        }),
      ).toEqual({
        ...legacy.getSafeOperationLimits(config, rate),
        burst: legacy.getOperationBurstLimit(4),
      });
    },
  );
  it('uses a configured burst cap independently from the safety factor', () => {
    vi.stubEnv('SP_API_RATE_LIMIT_SAFETY_FACTOR', '0.5');
    vi.stubEnv('SP_API_RATE_LIMIT_BURST_CAP', '2');
    const settings = resolveQuotaSettings({
      SP_API_RATE_LIMIT_SAFETY_FACTOR: '0.5',
      SP_API_RATE_LIMIT_BURST_CAP: '2',
    });
    const config = legacy.DEFAULT_OPERATION_CONFIGS.getCatalogItem!;
    expect(operationLimits(settings, 'getCatalogItem')).toEqual({
      ...legacy.getSafeOperationLimits(config),
      burst: legacy.getOperationBurstLimit(2),
    });
  });
  it('parses shared metadata so independent consumers use the same execution capacities', () => {
    const raw = JSON.stringify({
      rate: 1.5,
      burst: 4,
      source: 'response_header',
      updatedAt: '2026-01-02T00:00:00.000Z',
    });
    const metadata = parseQuotaMetadata(raw)!;
    const api = buildQuotaWindows(
      DEFAULT_QUOTA_SETTINGS,
      'EU',
      'getCatalogItem',
      metadata,
    );
    const worker = buildQuotaWindows(
      DEFAULT_QUOTA_SETTINGS,
      'EU',
      'getCatalogItem',
      parseQuotaMetadata(raw)!,
    );
    expect(api).toEqual(worker);
    expect(api.slice(2).map((window) => window.limit)).toEqual([3, 67, 4050]);
  });
  it.each([
    '{',
    '{"rate":0,"burst":99}',
    '{"rate":-1}',
    '{"rate":"Infinity"}',
    'null',
    '[]',
  ])('invalid metadata cannot change capacity: %s', (raw) => {
    expect(parseQuotaMetadata(raw)).toBeUndefined();
    expect(
      buildQuotaWindows(
        DEFAULT_QUOTA_SETTINGS,
        'US',
        'getCatalogItem',
        parseQuotaMetadata(raw),
      ),
    ).toEqual(
      buildQuotaWindows(DEFAULT_QUOTA_SETTINGS, 'US', 'getCatalogItem'),
    );
  });
  it('keeps compatible custom key prefixes and rejects invalid numeric resource bounds', () => {
    const settings = resolveQuotaSettings({
      RATE_LIMITER_KEY_PREFIX: 'fixture:quota',
      SP_API_RATE_LIMIT_PER_MINUTE: '80',
      SP_API_RATE_LIMIT_PER_HOUR: '2000',
    });
    expect(
      buildQuotaWindows(settings, 'EU', 'searchCatalogItems')
        .slice(0, 2)
        .map((window) => [window.key, window.limit]),
    ).toEqual([
      ['fixture:quota:EU:region:minute', 80],
      ['fixture:quota:EU:region:hour', 2000],
    ]);
    expect(() =>
      resolveQuotaSettings({ SP_API_RATE_LIMIT_PER_MINUTE: 'Infinity' }),
    ).toThrow('SP-API INVALID_CONFIG');
    expect(() =>
      resolveQuotaSettings({ SP_API_RATE_LIMIT_PER_MINUTE: '0' }),
    ).toThrow('SP-API INVALID_CONFIG');
  });
  it('does not accept normalized invalid calendar dates as metadata update times', () => {
    const metadata = parseQuotaMetadata(
      JSON.stringify({
        rate: 1,
        burst: 2,
        updatedAt: '2026-02-31T00:00:00.000Z',
      }),
    );
    expect(metadata).toEqual({ rate: 1, burst: 2, updatedAt: undefined });
  });
});
