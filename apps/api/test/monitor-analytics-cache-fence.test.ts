import { loadEnv } from '@asin-monitor/config';
import {
  parseMonitorAnalyticsQuery,
  type RoleRepositoryPort,
} from '@asin-monitor/db';
import type { FastifyReply } from 'fastify';
import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthPrincipal } from '../src/auth/auth.types';
import type { ApplicationDatabasePools } from '../src/database/database.service';
import type { AppLogger } from '../src/logger/app-logger.service';
import { MetricsService } from '../src/metrics/metrics.service';
import { MonitorAnalyticsCache } from '../src/monitor/monitor-analytics-cache';
import { analyticsCacheGenerationKey } from '../src/monitor/monitor-analytics-cache-control';
import { MonitorAnalyticsService } from '../src/monitor/monitor-analytics.service';
import { OpsService } from '../src/ops/ops.service';
import type { ApplicationRedisClient } from '../src/redis/redis.service';
import { monitorAnalyticsFixture } from './helpers/monitor-analytics-fixture';

const env = loadEnv({
  DATABASE_URL: 'postgresql://localhost/analytics_fence_255',
  COMPETITOR_DATABASE_URL:
    'postgresql://localhost/analytics_fence_competitor_255',
  REDIS_URL: 'redis://localhost/15',
  JWT_SECRET: 'fixture-fence-255',
  AUTH_DATA_AUTHORITY: 'postgresql',
  BULL_PREFIX: 'analytics-fence-boundaries-255',
});
const query = parseMonitorAnalyticsQuery('all-countries-summary', {});
const generation = analyticsCacheGenerationKey(env.BULL_PREFIX);
const status = `${env.BULL_PREFIX}:neo:ops:analytics-cache:last-cleared-at`;
const old = 'a'.repeat(64),
  other = 'b'.repeat(64);
const resources: MetricsService[] = [];
afterEach(() => {
  for (const resource of resources.splice(0)) resource.onModuleDestroy();
  vi.restoreAllMocks();
});
function fixture() {
  const f = monitorAnalyticsFixture();
  f.permissions.push('settings:write');
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as AppLogger;
  const redis = {
    ...f.redis,
    scan: vi.fn(async () => ['0', [...f.values.keys()]] as [string, string[]]),
    unlink: vi.fn(async (...keys: string[]) => {
      let count = 0;
      for (const key of keys) if (f.values.delete(key)) count++;
      return count;
    }),
  };
  const metrics = new MetricsService();
  resources.push(metrics);
  const cache = new MonitorAnalyticsCache(
    env,
    redis as unknown as ApplicationRedisClient,
    logger,
    metrics,
  );
  const service = new MonitorAnalyticsService(env, f.repository, cache, logger);
  const roles: RoleRepositoryPort = {
    read: async (action) => action(f.unit),
    transaction: async (action) => action(f.unit),
  };
  const ops = new OpsService(
    env,
    {} as ApplicationDatabasePools,
    redis as unknown as ApplicationRedisClient,
    logger,
    roles,
    vi.fn(),
  );
  const principal = {
    userId: f.user.id,
    sessionId: f.session.id,
  } as AuthPrincipal;
  const read = async () => {
    const raw = Object.assign(new EventEmitter(), { destroyed: false });
    try {
      return JSON.parse(
        await service.read(
          principal,
          { raw } as unknown as FastifyReply,
          query.operation,
          {},
        ),
      );
    } finally {
      raw.emit('finish');
      raw.emit('close');
    }
  };
  return { ...f, redis, cache, ops, principal, read, logger };
}
describe('analytics cache fence application boundaries with a semantic Redis port', () => {
  it.each([
    { label: 'wrong type', stored: { kind: 'other' as const } },
    {
      label: 'oversize',
      stored: { kind: 'string' as const, value: 'x'.repeat(2097153) },
    },
    {
      label: 'TTL',
      stored: {
        kind: 'string' as const,
        value: old,
        expiresAt: Date.now() + 60000,
      },
    },
    {
      label: 'non hex',
      stored: { kind: 'string' as const, value: 'z'.repeat(64) },
    },
  ])(
    'falls back to the database without fill or control repair for $label',
    async ({ stored }) => {
      const f = fixture();
      f.cacheModel.controls.set(generation, stored);
      expect((await f.read()).meta.cacheHit).toBe(false);
      expect(f.unit.duration).toHaveBeenCalledOnce();
      expect(f.redis.eval).toHaveBeenCalledOnce();
      expect(f.values.size).toBe(0);
      expect(f.cacheModel.controls.get(generation)).toEqual(stored);
      expect(f.cacheModel.diagnostics.payloadGets).toBe(0);
    },
  );
  it('does not refill after a lookup failure, and uses no replacement lease after SQL', async () => {
    const f = fixture();
    f.redis.eval.mockRejectedValueOnce(new Error('TEST_REDIS_UNAVAILABLE'));
    expect((await f.read()).meta.cacheHit).toBe(false);
    expect(f.unit.duration).toHaveBeenCalledOnce();
    expect(f.redis.eval).toHaveBeenCalledOnce();
    expect(f.values.size).toBe(0);
  });
  it('rejects old v1 and mismatched-generation envelopes while accepting a fresh v2 fill', async () => {
    const f = fixture();
    const initial = await f.cache.lookup(query);
    const result = await f.unit.duration(query);
    await f.cache.set(query, result, Date.now(), initial.lease);
    const valid = JSON.parse(f.values.get(f.cache.key(query))!);
    expect(valid.version).toBe(2);
    expect(valid.generation).toBe(initial.lease);
    expect((await f.cache.lookup(query)).cached).not.toBeNull();
    for (const invalid of [
      { ...valid, version: 1 },
      { ...valid, generation: other },
    ]) {
      f.values.set(f.cache.key(query), JSON.stringify(invalid));
      expect(await f.cache.lookup(query)).toEqual({
        cached: null,
        lease: initial.lease,
      });
    }
  });
  it.each(['scan', 'unlink'] as const)(
    'returns 503 and preserves existing generation/status on %s failure',
    async (command) => {
      const f = fixture();
      f.cacheModel.controls.set(generation, { kind: 'string', value: old });
      f.values.set(f.cache.key(query), 'old');
      f.redis[command].mockRejectedValueOnce(new Error('TEST_COMMAND_FAILED'));
      await expect(f.ops.clearCache(f.principal)).rejects.toMatchObject({
        status: 503,
      });
      expect(f.cacheModel.controls.get(generation)).toEqual({
        kind: 'string',
        value: old,
      });
      expect(await f.cacheModel.get(status)).toBeNull();
      expect(f.redis.eval).toHaveBeenCalledOnce();
    },
  );
  it('returns 409 on a known concurrent CAS conflict without reverting the winning generation', async () => {
    const f = fixture();
    f.cacheModel.controls.set(generation, { kind: 'string', value: old });
    f.redis.scan.mockImplementationOnce(async () => {
      f.cacheModel.controls.set(generation, { kind: 'string', value: other });
      return ['0', []];
    });
    await expect(f.ops.clearCache(f.principal)).rejects.toMatchObject({
      status: 409,
    });
    expect(f.cacheModel.controls.get(generation)).toEqual({
      kind: 'string',
      value: other,
    });
    expect(await f.cacheModel.get(status)).toBeNull();
  });
  it('returns 503 after final execution loses its ACK, without rolling back or retrying the token', async () => {
    const f = fixture();
    f.cacheModel.controls.set(generation, { kind: 'string', value: old });
    const originalEval = f.redis.eval.getMockImplementation()!;
    f.redis.eval.mockImplementation(async (script, keys, args) => {
      const result = await originalEval(script, keys, args);
      if (script.startsWith('-- neo-analytics-cache-rotate:v2'))
        throw new Error('TEST_ACK_LOST');
      return result;
    });
    await expect(f.ops.clearCache(f.principal)).rejects.toMatchObject({
      status: 503,
    });
    expect(f.cacheModel.controls.get(generation)).not.toEqual({
      kind: 'string',
      value: old,
    });
    expect(await f.cacheModel.get(status)).toEqual(expect.any(String));
    expect(f.redis.eval).toHaveBeenCalledTimes(2);
  });
  it('rejects a late final ACK under the original monotonic budget even when timers are delayed', async () => {
    const f = fixture();
    let localNow = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => localNow);
    f.cacheModel.controls.set(generation, { kind: 'string', value: old });
    const originalEval = f.redis.eval.getMockImplementation()!;
    f.redis.eval.mockImplementation(async (script, keys, args) => {
      const result = await originalEval(script, keys, args);
      if (script.startsWith('-- neo-analytics-cache-rotate:v2'))
        localNow = 5001;
      return result;
    });
    await expect(f.ops.clearCache(f.principal)).rejects.toMatchObject({
      status: 503,
    });
    expect(f.cacheModel.controls.get(generation)).not.toEqual({
      kind: 'string',
      value: old,
    });
    expect(f.logger.info).not.toHaveBeenCalled();
    expect(f.redis.eval).toHaveBeenCalledTimes(2);
  });
});
