import { loadEnv } from '@asin-monitor/config';
import type { MonitorAnalyticsOperation } from '@asin-monitor/db';
import type { FastifyReply } from 'fastify';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthPrincipal } from '../src/auth/auth.types';
import type { AppLogger } from '../src/logger/app-logger.service';
import type { MetricsService } from '../src/metrics/metrics.service';
import { MonitorAnalyticsCache } from '../src/monitor/monitor-analytics-cache';
import { MonitorAnalyticsService } from '../src/monitor/monitor-analytics.service';
import type { ApplicationRedisClient } from '../src/redis/redis.service';
import { monitorAnalyticsFixture } from './helpers/monitor-analytics-fixture';

// Supplement the frozen actual Fastify and PostgreSQL files without editing
// them. Raw object/non-string shapes cannot be emitted by Fastify's ordinary
// URL decoder, so these cases target the existing public abnormal read entry.
// No unimplemented normalizer/helper is imported: unchanged main must compile
// before a behavioral RED can be observed. Nothing in this file is executed
// while preparation owns only a light slot.
const malformed = [
  { name: 'object', value: { value: ' raw,id ' } },
  { name: 'numeric scalar', value: 7 },
  { name: 'boolean scalar', value: false },
  { name: 'null scalar', value: null },
  { name: 'undefined scalar', value: undefined },
  { name: 'null item', value: [null] },
  { name: 'numeric item', value: [7] },
  { name: 'object item', value: [{ value: 'id' }] },
  { name: 'nested array', value: [['id']] },
  { name: 'mixed array', value: ['valid-id', false] },
  { name: 'undefined item', value: [undefined] },
  { name: 'sparse array', value: Array(1) },
] satisfies { name: string; value: unknown }[];
const regularAndBracket = [
  { name: 'scalar/scalar', regular: 'id', alias: 'id' },
  { name: 'array/array', regular: ['id'], alias: ['id'] },
  { name: 'empty regular', regular: '', alias: 'id' },
  { name: 'empty alias', regular: 'id', alias: '' },
] satisfies { name: string; regular: unknown; alias: unknown }[];

describe('Issue 241 existing abnormal input entry rejects malformed aliases', () => {
  let fixture: ReturnType<typeof monitorAnalyticsFixture>;
  let service: MonitorAnalyticsService;
  let principal: AuthPrincipal;
  let cache: MonitorAnalyticsCache;
  afterEach(() => {
    vi.restoreAllMocks();
  });
  beforeEach(() => {
    fixture = monitorAnalyticsFixture();
    const env = loadEnv({
      DATABASE_URL: 'postgresql://localhost/unused_241_input_fixture',
      COMPETITOR_DATABASE_URL:
        'postgresql://localhost/unused_241_input_competitor',
      REDIS_URL: 'redis://localhost:6379/15',
      JWT_SECRET: 'input-fixture-241-key-with-more-than-32-characters',
      AUTH_DATA_AUTHORITY: 'postgresql',
    });
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    cache = new MonitorAnalyticsCache(
      env,
      fixture.redis as unknown as ApplicationRedisClient,
      logger as unknown as AppLogger,
      { recordAnalyticsCacheAccess: vi.fn() } as unknown as MetricsService,
    );
    vi.spyOn(cache, 'get');
    vi.spyOn(cache, 'set');
    service = new MonitorAnalyticsService(
      env,
      fixture.repository,
      cache,
      logger as unknown as AppLogger,
    );
    principal = {
      userId: fixture.user.id,
      sessionId: fixture.session.id,
      user: { ...fixture.user, status: 'ACTIVE', forcePasswordChange: false },
    };
  });

  async function read(
    raw: unknown,
    operation: MonitorAnalyticsOperation = 'abnormal-duration-statistics',
  ) {
    // A minimal reply lifecycle port retains the real admission accounting.
    // Finish in finally so all pass/fail paths release its timeout and slot.
    const rawReply = Object.assign(new EventEmitter(), {
      destroyed: false,
      destroy: vi.fn(),
    });
    try {
      return await service.read(
        principal,
        { raw: rawReply } as unknown as FastifyReply,
        operation,
        raw,
      );
    } finally {
      rawReply.emit('finish');
    }
  }
  async function rejectsInput(raw: unknown) {
    await expect(read(raw)).rejects.toMatchObject({
      status: 400,
      response: {
        success: false,
        errorCode: 400,
        errorMessage: '统计查询参数无效',
      },
    });
    expect(fixture.unit.abnormal).not.toHaveBeenCalled();
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  }

  describe.each(['asinIds', 'asinCodes'] as const)(
    '%s exact alias boundary',
    (key) => {
      it.each(malformed)(
        'CONTROL: rejects $name before cache or data execution',
        async ({ value }) => {
          await rejectsInput({ [`${key}[]`]: value });
        },
      );
      it.each(['[0]', '[][0]', '[value]'])(
        'RED: rejects nested %s syntax instead of ignoring an intended restrictive filter',
        async (suffix) => {
          await rejectsInput({ [`${key}${suffix}`]: ' raw,id ' });
        },
      );
      it.each(regularAndBracket)(
        'RED: rejects ambiguous $name ownership even if one form is empty',
        async ({ regular, alias }) => {
          await rejectsInput({ [key]: regular, [`${key}[]`]: alias });
        },
      );
    },
  );

  it('CONTROL: ordinary scalar CSV retains trim, split, duplicates and asinType rules', async () => {
    await read({
      asinIds: ' first, second ,, first ',
      asinCodes: ' A, B ,,A ',
      asinType: ' MAIN_LINK ',
      includeSeries: '0',
    });
    expect(fixture.unit.abnormal).toHaveBeenLastCalledWith({
      operation: 'abnormal-duration-statistics',
      asinIds: ['first', 'second', 'first'],
      asinCodes: ['A', 'B', 'A'],
      asinType: 'MAIN_LINK',
      includeSeries: '0',
    });
  });
  it('CONTROL: regular real arrays retain padded comma-containing values and empty items', async () => {
    await read({
      asinIds: [' raw,id ', '', ' raw,id '],
      asinCodes: [' B,RAW ', ''],
      includeSeries: '0',
    });
    expect(fixture.unit.abnormal).toHaveBeenLastCalledWith({
      operation: 'abnormal-duration-statistics',
      asinIds: [' raw,id ', '', ' raw,id '],
      asinCodes: [' B,RAW ', ''],
      includeSeries: '0',
    });
  });
  it('CONTROL: other analytics operations keep their scalar unrelated-field behavior', async () => {
    await read({ 'asinIds[]': ' raw,id ' }, 'statistics');
    expect(fixture.unit.duration).toHaveBeenLastCalledWith({
      operation: 'statistics',
    });
    expect(fixture.unit.abnormal).not.toHaveBeenCalled();
  });
  it('RED: a single raw alias is wrapped without trim or comma splitting', async () => {
    await read({
      'asinIds[]': ' 00042,MiXeD ',
      'asinCodes[]': ' B,RAW ',
      includeSeries: '0',
    });
    expect(fixture.unit.abnormal).toHaveBeenLastCalledWith({
      operation: 'abnormal-duration-statistics',
      asinIds: [' 00042,MiXeD '],
      asinCodes: [' B,RAW '],
      includeSeries: '0',
    });
  });
  it('RED: repeated pure-string aliases retain their values and order without deduplication', async () => {
    await read({
      'asinIds[]': ['', ' raw,id ', ' raw,id '],
      'asinCodes[]': [' B,RAW ', ''],
      includeSeries: '0',
    });
    expect(fixture.unit.abnormal).toHaveBeenLastCalledWith({
      operation: 'abnormal-duration-statistics',
      asinIds: ['', ' raw,id ', ' raw,id '],
      asinCodes: [' B,RAW ', ''],
      includeSeries: '0',
    });
  });
});
