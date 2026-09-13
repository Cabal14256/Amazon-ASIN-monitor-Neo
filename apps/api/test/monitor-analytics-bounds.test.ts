import { loadEnv } from '@asin-monitor/config';
import {
  MonitorAnalyticsQueryError,
  MonitorAnalyticsResultLimitError,
  parseMonitorAnalyticsQuery,
} from '@asin-monitor/db';
import type { FastifyReply } from 'fastify';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthPrincipal } from '../src/auth/auth.types';
import type { AppLogger } from '../src/logger/app-logger.service';
import { MonitorAnalyticsCache } from '../src/monitor/monitor-analytics-cache';
import { assertMonitorJsonBounds } from '../src/monitor/monitor-analytics-result';
import { MonitorAnalyticsService } from '../src/monitor/monitor-analytics.service';
import type { ApplicationRedisClient } from '../src/redis/redis.service';
import { monitorAnalyticsFixture } from './helpers/monitor-analytics-fixture';

const env = loadEnv({
  DATABASE_URL: 'postgresql://localhost/analytics_109',
  COMPETITOR_DATABASE_URL: 'postgresql://localhost/analytics_competitor_109',
  REDIS_URL: 'redis://localhost/15',
  JWT_SECRET: 'fixture-109',
  AUTH_DATA_AUTHORITY: 'postgresql',
});
const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as AppLogger;
const query = parseMonitorAnalyticsQuery('by-time', {});
function fixture() {
  const f = monitorAnalyticsFixture();
  const cache = new MonitorAnalyticsCache(
    env,
    f.redis as unknown as ApplicationRedisClient,
    logger,
  );
  return {
    ...f,
    cache,
    service: new MonitorAnalyticsService(env, f.repository, cache, logger),
    principal: { userId: f.user.id, sessionId: f.session.id } as AuthPrincipal,
  };
}
const responses: EventEmitter[] = [];
function response() {
  const raw = Object.assign(new EventEmitter(), {
    destroyed: false,
    destroy(this: EventEmitter & { destroyed: boolean }) {
      this.destroyed = true;
      this.emit('close');
      return this;
    },
  });
  responses.push(raw);
  return { raw } as unknown as FastifyReply;
}
afterEach(() => {
  for (const raw of responses.splice(0)) raw.emit('close');
  vi.useRealTimers();
});
describe('monitor analytics response/cache resource bounds', () => {
  it('retains a disconnected authentication action until it settles without allocating another data slot', async () => {
    const f = fixture(),
      a = response(),
      b = response();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = f.service
      .admit(a, () => gate)
      .catch((error: unknown) => error);
    a.raw.emit('close');
    await f.service.admit(b, async () => true);
    await expect(
      f.service.admit(response(), async () => true),
    ).rejects.toMatchObject({ status: 429 });
    release();
    expect(await pending).toMatchObject({ status: 504 });
    const c = response();
    await f.service.admit(c, async () => true);
    await expect(
      f.service.read(f.principal, c, 'statistics', {}),
    ).resolves.toContain('"success":true');
  });
  it('measures escaped UTF-8 JSON before serialization, rejects cycles and excessive nesting', () => {
    const data = { 键: ['😀', '\n', null, true, 1.25] };
    const bytes = Buffer.byteLength(JSON.stringify(data));
    expect(() => assertMonitorJsonBounds(data, bytes)).not.toThrow();
    expect(() => assertMonitorJsonBounds(data, bytes - 1)).toThrow(
      MonitorAnalyticsResultLimitError,
    );
    const cycle: unknown[] = [];
    cycle.push(cycle);
    expect(() => assertMonitorJsonBounds(cycle)).toThrow(
      MonitorAnalyticsQueryError,
    );
    expect(() => assertMonitorJsonBounds([new Array(50001).fill(0)])).toThrow(
      MonitorAnalyticsResultLimitError,
    );
    let deep: unknown = null;
    for (let i = 0; i < 14; i++) deep = [deep];
    expect(() => assertMonitorJsonBounds(deep)).toThrow(
      MonitorAnalyticsResultLimitError,
    );
    expect(() => assertMonitorJsonBounds({ value: Infinity })).toThrow(
      MonitorAnalyticsQueryError,
    );
  });
  it('retains two response slots after query completion and destroys slow delivery at sixty seconds', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      a = response(),
      b = response();
    await f.service.read(f.principal, a, 'statistics', {});
    await f.service.read(f.principal, b, 'statistics', {});
    await expect(
      f.service.read(f.principal, response(), 'statistics', {}),
    ).rejects.toMatchObject({ status: 429 });
    a.raw.emit('finish');
    a.raw.emit('close');
    const c = response();
    await f.service.read(f.principal, c, 'statistics', {});
    await vi.advanceTimersByTimeAsync(60000);
    expect(b.raw.destroyed).toBe(true);
    expect(c.raw.destroyed).toBe(true);
    expect(a.raw.listenerCount('close')).toBe(0);
    await expect(
      f.service.read(f.principal, response(), 'statistics', {}),
    ).resolves.toContain('"success":true');
  });
  it('retains a disconnected database action until it settles and prevents subsequent data/cache access', async () => {
    const f = fixture(),
      a = response();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(f.repository.read).mockImplementationOnce(async (action) => {
      await gate;
      return action(f.unit);
    });
    const pending = f.service
      .read(f.principal, a, 'by-time', {})
      .catch((error: unknown) => error);
    a.raw.emit('close');
    await f.service.read(f.principal, response(), 'statistics', {});
    await expect(
      f.service.read(f.principal, response(), 'statistics', {}),
    ).rejects.toMatchObject({ status: 429 });
    release();
    expect(await pending).toMatchObject({ status: 504 });
    expect(f.redis.eval).not.toHaveBeenCalled();
    expect(f.unit.duration).toHaveBeenCalledTimes(1);
  });
  it('bounds unavailable cache attempts to four until their real commands settle', async () => {
    vi.useFakeTimers();
    const f = fixture();
    let release!: (value: null) => void;
    const gate = new Promise<null>((resolve) => {
      release = resolve;
    });
    f.redis.eval.mockImplementation(() => gate);
    const pending = Promise.all(
      Array.from({ length: 4 }, () => f.cache.get(query)),
    );
    await vi.advanceTimersByTimeAsync(500);
    expect(await pending).toEqual([null, null, null, null]);
    expect(await f.cache.get(query)).toBeNull();
    expect(f.redis.eval).toHaveBeenCalledTimes(4);
    release(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(await f.cache.get(query)).toBeNull();
    expect(f.redis.eval).toHaveBeenCalledTimes(5);
  });
  it('skips oversized writes and rejects a cache value copied from a different query', async () => {
    const f = fixture();
    await f.cache.set(
      query,
      { data: 'x'.repeat(3 * 1024 * 1024), source: 'raw' },
      Date.now(),
    );
    expect(f.redis.eval).not.toHaveBeenCalled();
    await f.cache.set(query, { data: [], source: 'raw' }, Date.now());
    const other = parseMonitorAnalyticsQuery('by-time', { country: 'US' });
    f.values.set(f.cache.key(other), f.values.get(f.cache.key(query))!);
    expect(await f.cache.get(other)).toBeNull();
    expect(await f.cache.get(query)).toMatchObject({ data: [], source: 'raw' });
  });
  it('changes cache identity when aggregate configuration changes and supports TTL zero', async () => {
    const f = fixture();
    const disabled = new MonitorAnalyticsCache(
      {
        ...env,
        ANALYTICS_STATISTICS_BY_TIME_TTL_MS: 0,
        ANALYTICS_AGG_ENABLED: false,
      },
      f.redis as unknown as ApplicationRedisClient,
      logger,
    );
    expect(disabled.key(query)).not.toBe(f.cache.key(query));
    await disabled.set(query, { data: [], source: 'raw' }, Date.now());
    expect(await disabled.get(query)).toBeNull();
    expect(f.redis.eval).not.toHaveBeenCalled();
  });
});
