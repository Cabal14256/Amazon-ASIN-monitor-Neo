import { loadEnv } from '@asin-monitor/config';
import {
  parseMonitorAnalyticsQuery,
  type RoleRepositoryPort,
  type RoleWriteUnit,
} from '@asin-monitor/db';
import type { FastifyReply } from 'fastify';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthPrincipal } from '../src/auth/auth.types';
import type { ApplicationDatabasePools } from '../src/database/database.service';
import type { AppLogger } from '../src/logger/app-logger.service';
import { MetricsService } from '../src/metrics/metrics.service';
import { MonitorAnalyticsCache } from '../src/monitor/monitor-analytics-cache';
import { MonitorAnalyticsService } from '../src/monitor/monitor-analytics.service';
import { OpsService } from '../src/ops/ops.service';
import type { ApplicationRedisClient } from '../src/redis/redis.service';
import { monitorAnalyticsFixture } from './helpers/monitor-analytics-fixture';

// Existing product imports only: an original RED must be a behavioral assertion,
// not an import failure for a future generation/control module. This fixture
// models Redis execution order; real Lua CAS requires the separate native oracle.
const env = loadEnv({
  DATABASE_URL: 'postgresql://localhost/analytics_clear_255',
  COMPETITOR_DATABASE_URL:
    'postgresql://localhost/analytics_clear_competitor_255',
  REDIS_URL: 'redis://localhost/15',
  JWT_SECRET: 'fixture-clear-255',
  AUTH_DATA_AUTHORITY: 'postgresql',
  BULL_PREFIX: 'analytics-clear-fence-255',
});
const query = parseMonitorAnalyticsQuery('all-countries-summary', {});
const resources: MetricsService[] = [];
const replies: EventEmitter[] = [];
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
function reply() {
  const raw = Object.assign(new EventEmitter(), { destroyed: false });
  replies.push(raw);
  return { raw } as unknown as FastifyReply;
}
function finish(response: FastifyReply) {
  (response.raw as unknown as EventEmitter).emit('finish');
  (response.raw as unknown as EventEmitter).emit('close');
}
afterEach(() => {
  for (const resource of resources.splice(0)) resource.onModuleDestroy();
  for (const raw of replies.splice(0)) raw.emit('close');
});
async function fixture() {
  const f = monitorAnalyticsFixture();
  f.permissions.push('settings:write');
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as AppLogger;
  const base = await f.unit.duration(query);
  const old = {
    ...base,
    data: { ...(base.data as object), timeRange: 'before-clear' },
  };
  const fresh = {
    ...base,
    data: { ...(base.data as object), timeRange: 'after-clear' },
  };
  let database = old;
  const firstDuration = vi.fn(async () => structuredClone(database));
  const secondDuration = vi.fn(async () => structuredClone(database));
  const originalEval = f.redis.eval.getMockImplementation()!;
  const writeReady = deferred<void>();
  const releaseWrite = deferred<void>();
  const writeExecuted = deferred<void>();
  let holdNextWrite = false;
  const shared = {
    client: {},
    eval: vi.fn(
      async (script: string, keys: string[], args: (string | number)[]) => {
        // Only the payload-bearing analytics write is delayed. Ops control writes
        // and lookup/generation reads must remain usable on the independent client.
        const held =
          holdNextWrite &&
          keys.some((key) =>
            key.startsWith(`${env.BULL_PREFIX}:neo:analytics:v1:`),
          ) &&
          args.some(
            (argument) =>
              typeof argument === 'string' && argument.startsWith('{'),
          );
        if (held) {
          holdNextWrite = false;
          writeReady.resolve();
          await releaseWrite.promise;
        }
        const result = await originalEval(script, keys, args);
        if (held) writeExecuted.resolve();
        return result;
      },
    ),
    get: vi.fn(async (key: string) => f.values.get(key) ?? null),
    setex: vi.fn(async (key: string, _ttl: number, value: string) => {
      f.values.set(key, value);
    }),
    scan: vi.fn(
      async (_cursor: string, pattern: string) =>
        [
          '0',
          [...f.values.keys()].filter((key) =>
            key.startsWith(pattern.slice(0, -1)),
          ),
        ] as [string, string[]],
    ),
    unlink: vi.fn(async (...keys: string[]) => {
      let removed = 0;
      for (const key of keys) if (f.values.delete(key)) removed++;
      return removed;
    }),
  } as unknown as ApplicationRedisClient;
  const makeReader = (duration: typeof firstDuration) => {
    const metrics = new MetricsService();
    resources.push(metrics);
    const cache = new MonitorAnalyticsCache(env, shared, logger, metrics);
    const service = new MonitorAnalyticsService(
      env,
      { read: async (action) => action({ ...f.unit, duration }) },
      cache,
      logger,
    );
    return { cache, service };
  };
  const first = makeReader(firstDuration);
  const second = makeReader(secondDuration);
  const roleUnit: RoleWriteUnit = {
    ...f.unit,
    listRoles: vi.fn(async () => []),
    findRole: vi.fn(async () => undefined),
    listPermissions: vi.fn(async () => []),
    listRolePermissions: vi.fn(async () => []),
    usersWithRole: vi.fn(async () => []),
    replacePermissions: vi.fn(async () => {}),
  };
  const roles: RoleRepositoryPort = {
    read: async (action) => action(roleUnit),
    transaction: async (action) => action(roleUnit),
  };
  const ops = new OpsService(
    env,
    {} as ApplicationDatabasePools,
    shared,
    logger,
    roles,
    vi.fn(),
  );
  const principal = {
    userId: f.user.id,
    sessionId: f.session.id,
  } as AuthPrincipal;
  const read = async (reader: typeof first) => {
    const response = reply();
    try {
      return JSON.parse(
        await reader.service.read(
          principal,
          response,
          'all-countries-summary',
          {},
        ),
      );
    } finally {
      finish(response);
    }
  };
  return {
    first,
    second,
    ops,
    principal,
    read,
    old,
    fresh,
    firstDuration,
    secondDuration,
    writeReady,
    releaseWrite,
    writeExecuted,
    useFresh: () => {
      database = fresh;
    },
    holdWrite: () => {
      holdNextWrite = true;
    },
  };
}
describe('analytics clear fence original behavioral oracle', () => {
  it('RED late SQL result cannot refill a cache after another instance reports clear success', async () => {
    const f = await fixture();
    const sqlRead = deferred<void>();
    const releaseSql = deferred<void>();
    f.firstDuration.mockImplementationOnce(async () => {
      const captured = structuredClone(f.old);
      sqlRead.resolve();
      await releaseSql.promise;
      return captured;
    });
    const pending = f.read(f.first);
    try {
      await sqlRead.promise;
      expect(await f.ops.clearCache(f.principal)).toMatchObject({
        success: true,
      });
      f.useFresh();
    } finally {
      releaseSql.resolve();
    }
    // The request that read before clear may return its old data. The following
    // independent reader must not hit a refill made from that pre-clear read.
    expect((await pending).data).toEqual(f.old.data);
    expect(await f.read(f.second)).toMatchObject({
      data: f.fresh.data,
      meta: { cacheHit: false },
    });
    expect(f.secondDuration).toHaveBeenCalledOnce();
  });
  it('RED a Redis write already issued before clear cannot execute afterward as a reusable old fill', async () => {
    const f = await fixture();
    f.holdWrite();
    const pending = f.read(f.first);
    try {
      await f.writeReady.promise;
      expect(await f.ops.clearCache(f.principal)).toMatchObject({
        success: true,
      });
      f.useFresh();
    } finally {
      f.releaseWrite.resolve();
    }
    await f.writeExecuted.promise;
    expect((await pending).data).toEqual(f.old.data);
    expect(await f.read(f.second)).toMatchObject({
      data: f.fresh.data,
      meta: { cacheHit: false },
    });
    expect(f.secondDuration).toHaveBeenCalledOnce();
  });
  it('healthy normal fill is read by an independent cache instance without another data query', async () => {
    const f = await fixture();
    expect(await f.read(f.first)).toMatchObject({
      data: f.old.data,
      meta: { cacheHit: false },
    });
    expect(await f.read(f.second)).toMatchObject({
      data: f.old.data,
      meta: { cacheHit: true },
    });
    expect(f.firstDuration).toHaveBeenCalledOnce();
    expect(f.secondDuration).not.toHaveBeenCalled();
  });
  it('healthy ordinary clear removes a completed fill and allows fresh fill followed by hit', async () => {
    const f = await fixture();
    await f.read(f.first);
    f.useFresh();
    expect(await f.ops.clearCache(f.principal)).toMatchObject({
      success: true,
    });
    expect(await f.read(f.second)).toMatchObject({
      data: f.fresh.data,
      meta: { cacheHit: false },
    });
    expect(await f.read(f.first)).toMatchObject({
      data: f.fresh.data,
      meta: { cacheHit: true },
    });
    expect(f.firstDuration).toHaveBeenCalledOnce();
    expect(f.secondDuration).toHaveBeenCalledOnce();
  });
});
