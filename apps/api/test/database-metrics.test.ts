import { loadEnv } from '@asin-monitor/config';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Client, Pool } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENV } from '../src/config/config.module';
import { DatabaseModule } from '../src/database/database.module';
import { ApplicationDatabasePools } from '../src/database/database.service';
import { observedPgClient } from '../src/database/observed-pg-client';
import { configureHttpApp } from '../src/http-app';
import { AppLogger } from '../src/logger/app-logger.service';
import { MetricsModule } from '../src/metrics/metrics.module';
import { MetricsService } from '../src/metrics/metrics.service';

const result = {
  rows: [{ value: 7 }],
  command: 'SELECT',
  rowCount: 1,
  oid: 0,
  fields: [],
};
const sqlError = new Error('synthetic private SQL failure');
let app: NestFastifyApplication | undefined;
let pools: ApplicationDatabasePools;
let metrics: MetricsService;
let hold: (() => void) | undefined;
const queries: Array<{ config: unknown; values: unknown; client: Client }> = [];

beforeEach(async () => {
  queries.length = 0;
  hold = undefined;
  // Replace transport only: real pg Pool creates, checks out and releases real
  // Client instances. No production pool or metrics adapter is mocked.
  vi.spyOn(Client.prototype, 'connect').mockImplementation(function (
    this: Client,
    callback?: (error?: Error) => void,
  ) {
    queueMicrotask(() => callback?.());
    return undefined as never;
  } as never);
  vi.spyOn(Client.prototype, 'end').mockImplementation(function (
    this: Client,
    callback?: () => void,
  ) {
    queueMicrotask(() => {
      this.emit('end');
      callback?.();
    });
    return undefined as never;
  } as never);
  vi.spyOn(Client.prototype, 'query').mockImplementation(function (
    this: Client,
    ...args: unknown[]
  ) {
    const config = args[0];
    const object =
      config && typeof config === 'object'
        ? (config as Record<string, unknown>)
        : undefined;
    const text =
      typeof config === 'string' ? config : String(object?.text ?? '');
    queries.push({ config, values: args[1], client: this });
    const callback =
      typeof args[2] === 'function'
        ? args[2]
        : typeof args[1] === 'function'
        ? args[1]
        : object?.callback;
    if (typeof callback === 'function') {
      const settle = () =>
        callback.call(
          this,
          text.includes('FAIL') ? sqlError : null,
          text.includes('FAIL') ? undefined : result,
        );
      if (text.includes('HOLD')) hold = settle;
      else queueMicrotask(settle);
      return undefined;
    }
    return new Promise((resolve, reject) => {
      const settle = () =>
        text.includes('FAIL') ? reject(sqlError) : resolve(result);
      if (text.includes('HOLD')) hold = settle;
      else queueMicrotask(settle);
    });
  } as never);
  const moduleRef = await Test.createTestingModule({
    imports: [DatabaseModule, MetricsModule],
  })
    .overrideProvider(ENV)
    .useValue(
      loadEnv({
        DATABASE_URL: 'postgresql://localhost/metrics_fixture',
        COMPETITOR_DATABASE_URL:
          'postgresql://localhost/competitor_metrics_fixture',
        REDIS_URL: 'redis://localhost:6399',
        JWT_SECRET: 'synthetic-metrics-key',
        AUTH_DATA_AUTHORITY: 'postgresql',
        DATABASE_POOL_CONNECTION_TIMEOUT_MS: '100',
      }),
    )
    .overrideProvider(AppLogger)
    .useValue({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() })
    .compile();
  app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ logger: false }),
  );
  metrics = app.get(MetricsService);
  pools = app.get(ApplicationDatabasePools);
  configureHttpApp(app, { metrics });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
});
afterEach(async () => {
  hold?.();
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
});
async function scrape() {
  const response = await app!
    .getHttpAdapter()
    .getInstance()
    .inject({ method: 'GET', url: '/metrics' });
  expect(response.statusCode).toBe(200);
  return response.body;
}

describe('dual PostgreSQL metrics through actual Nest modules and native Pool', () => {
  it('CONTROL preserves result/error identity, native client leases and duplicate-release protection', async () => {
    expect(pools.primaryPool).toBeInstanceOf(Pool);
    expect(pools.competitorPool).toBeInstanceOf(Pool);
    expect(
      await pools.primaryPool.query('SELECT fixture_private_identifier'),
    ).toBe(result);
    await expect(pools.competitorPool.query('SELECT FAIL')).rejects.toBe(
      sqlError,
    );
    const client = await pools.primaryPool.connect();
    try {
      expect(client).toBeInstanceOf(Client);
      expect(await client.query('SELECT direct')).toBe(result);
    } finally {
      client.release();
    }
    expect(() => client.release()).toThrow();
    expect(pools.primaryPool.totalCount).toBe(1);
    expect(pools.primaryPool.idleCount).toBe(1);
  });
  it('CONTROL preserves callback return, this, config and values through the actual pool', async () => {
    const client = await pools.primaryPool.connect();
    const config = {
      text: 'SELECT fixture_private',
      name: 'private_name',
      rowMode: 'array' as const,
      values: [42],
    };
    try {
      await new Promise<void>((resolve, reject) => {
        const returned = client.query(
          config,
          function (this: Client, error, value) {
            try {
              expect(error).toBeNull();
              expect(value).toBe(result);
              expect(this).toBe(client);
              resolve();
            } catch (failure) {
              reject(failure);
            }
          },
        );
        expect(returned).toBeUndefined();
      });
      expect(queries.at(-1)?.config).toBe(config);
    } finally {
      client.release();
    }
  });
  it('RED records each actual success/error invocation once across both databases with success-only duration', async () => {
    await pools.primaryPool.query('SELECT synthetic_private_table');
    await expect(pools.competitorPool.query('SELECT FAIL')).rejects.toBe(
      sqlError,
    );
    const body = await scrape();
    expect(body).toContain(
      'amazon_asin_monitor_db_queries_total{table="unknown",operation="SELECT",status="success"} 1',
    );
    expect(body).toContain(
      'amazon_asin_monitor_db_queries_total{table="unknown",operation="SELECT",status="error"} 1',
    );
    expect(body).toContain(
      'amazon_asin_monitor_db_query_duration_seconds_count{table="unknown",operation="SELECT"} 1',
    );
    expect(body).not.toContain('synthetic_private_table');
  });
  it('RED exposes both live pools without borrowing SQL connections while all primary clients are leased', async () => {
    const leases = await Promise.all(
      Array.from({ length: 10 }, () => pools.primaryPool.connect()),
    );
    try {
      await pools.competitorPool.query('SELECT competitor');
      const before = queries.length;
      const body = await scrape();
      expect(queries).toHaveLength(before);
      for (const [name, total, idle, active] of [
        ['database', 10, 0, 10],
        ['competitor_database', 1, 1, 0],
      ] as const) {
        expect(body).toContain(
          `amazon_asin_monitor_db_pool_total_connections{database="${name}"} ${total}`,
        );
        expect(body).toContain(
          `amazon_asin_monitor_db_pool_idle_connections{database="${name}"} ${idle}`,
        );
        expect(body).toContain(
          `amazon_asin_monitor_db_pool_active_connections{database="${name}"} ${active}`,
        );
        expect(body).toContain(
          `amazon_asin_monitor_db_pool_waiting_requests{database="${name}"} 0`,
        );
        expect(body).toContain(
          `amazon_asin_monitor_db_pool_connection_limit{database="${name}"} 10`,
        );
      }
    } finally {
      for (const client of leases) client.release();
    }
  });
  it('keeps config callback this/arguments and restores the original embedded callback', async () => {
    const client = await pools.primaryPool.connect();
    try {
      let callback!: (this: unknown, error: unknown, value: unknown) => void;
      const completed = new Promise<void>((resolve, reject) => {
        callback = function (error, value) {
          try {
            expect(this).toBe(client);
            expect(error).toBeNull();
            expect(value).toBe(result);
            resolve();
          } catch (failure) {
            reject(failure);
          }
        };
      });
      const config = { text: 'SELECT embedded', callback };
      expect(client.query(config)).toBeUndefined();
      await completed;
      expect(config.callback).toBe(callback);
      const body = await scrape();
      expect(body).toContain(
        'amazon_asin_monitor_db_queries_total{table="unknown",operation="SELECT",status="success"} 1',
      );
    } finally {
      client.release();
    }
  });
  it('counts direct callback failures once and classifies only the initial bounded SQL token', async () => {
    const client = await pools.primaryPool.connect();
    try {
      await new Promise<void>((resolve) => {
        expect(
          client.query('DELETE FAIL', (error) => {
            expect(error).toBe(sqlError);
            resolve();
          }),
        ).toBeUndefined();
      });
      for (const text of [
        ' /* private */ SELECT 1',
        'WITH private AS (SELECT 1) SELECT 1',
        'BEGIN',
        ' '.repeat(65) + 'SELECT private',
      ])
        await client.query(text);
      for (const text of [
        'select 1',
        'INSERT INTO private VALUES(1)',
        'UPDATE private SET a=2',
      ])
        await client.query(text);
      const body = await scrape();
      expect(body).toContain(
        'amazon_asin_monitor_db_queries_total{table="unknown",operation="OTHER",status="success"} 4',
      );
      expect(body).toContain(
        'amazon_asin_monitor_db_queries_total{table="unknown",operation="DELETE",status="error"} 1',
      );
      expect(body).not.toContain(
        'db_query_duration_seconds_count{table="unknown",operation="DELETE"}',
      );
    } finally {
      client.release();
    }
  });
  it('observes actual query settlement and reads a waiting lease without adding SQL failures', async () => {
    const running = pools.primaryPool.query('SELECT HOLD');
    await vi.waitFor(() => expect(hold).toBeTypeOf('function'));
    expect(await scrape()).not.toContain(
      'db_queries_total{table="unknown",operation="SELECT"',
    );
    hold!();
    expect(await running).toBe(result);
    hold = undefined;
    const leases = await Promise.all(
      Array.from({ length: 10 }, () => pools.primaryPool.connect()),
    );
    const waiting = pools.primaryPool
      .connect()
      .catch((error: unknown) => error);
    try {
      await vi.waitFor(() => expect(pools.primaryPool.waitingCount).toBe(1));
      expect(await scrape()).toContain(
        'amazon_asin_monitor_db_pool_waiting_requests{database="database"} 1',
      );
      expect(await waiting).toBeInstanceOf(Error);
      expect(await scrape()).not.toContain('status="error"');
    } finally {
      for (const lease of leases) lease.release();
    }
  });
  it('never replaces native results, errors or callback return values when metric recording throws', async () => {
    vi.spyOn(metrics, 'recordDatabaseQuery').mockImplementation(() => {
      throw new Error('private observer failure');
    });
    expect(await pools.primaryPool.query('SELECT value')).toBe(result);
    await expect(pools.competitorPool.query('SELECT FAIL')).rejects.toBe(
      sqlError,
    );
    const client = await pools.primaryPool.connect();
    try {
      await new Promise<void>((resolve) => {
        expect(
          client.query('SELECT value', (_error, value) => {
            expect(value).toBe(result);
            resolve();
          }),
        ).toBeUndefined();
      });
    } finally {
      client.release();
    }
  });
  it('passes Submittable objects and native synchronous throws through without changing the submitted object', async () => {
    const native = vi.mocked(Client.prototype.query);
    const submittable = { submit: vi.fn() };
    native.mockReturnValueOnce(submittable as never);
    const record = vi.fn();
    const observed = new (observedPgClient(record, vi.fn()))();
    expect(observed.query(submittable as never)).toBe(submittable);
    expect(native).toHaveBeenLastCalledWith(submittable);
    expect(record).not.toHaveBeenCalled();
    const error = new TypeError('private input');
    native.mockImplementationOnce(() => {
      throw error;
    });
    expect(() => observed.query(undefined as never)).toThrow(error);
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith('OTHER', 'error', expect.any(Number));
  });
});
