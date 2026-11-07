import { loadEnv } from '@asin-monitor/config';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { Client, Pool, types } from 'pg';
import { describe, expect, it } from 'vitest';
import { ENV } from '../../src/config/config.module';
import { DatabaseModule } from '../../src/database/database.module';
import { ApplicationDatabasePools } from '../../src/database/database.service';
import { configureHttpApp } from '../../src/http-app';
import { MetricsModule } from '../../src/metrics/metrics.module';
import { MetricsService } from '../../src/metrics/metrics.service';

/** Registered by health.test.ts, which the existing Integration selector runs.
 * Only session-local temp objects are created; no shared fixture is modified. */
export function registerDatabaseMetricsNative() {
  describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
    'native dual PostgreSQL query metrics',
    () => {
      it('preserves SQL/config/callback/transaction behavior and exposes both saturated native pools', async () => {
        if (process.env.INTEGRATION_ALLOW_DROP_DATABASES !== 'true')
          throw new Error('Disposable integration opt-in required');
        for (const [key, database] of [
          ['DATABASE_URL', 'amazon_asin_monitor_ci'],
          ['COMPETITOR_DATABASE_URL', 'amazon_competitor_monitor_ci'],
        ]) {
          const url = new URL(process.env[key] ?? '');
          if (
            url.protocol !== 'postgresql:' ||
            url.hostname !== '127.0.0.1' ||
            url.port !== '5432' ||
            url.pathname !== `/${database}` ||
            url.password ||
            url.search ||
            url.hash
          )
            throw new Error(
              'Database metrics requires exact disposable loopback targets',
            );
        }
        const env = loadEnv({
          ...process.env,
          AUTH_DATA_AUTHORITY: 'postgresql',
          DATABASE_POOL_CONNECTION_TIMEOUT_MS: '1000',
        });
        const moduleRef = await Test.createTestingModule({
          imports: [DatabaseModule, MetricsModule],
        })
          .overrideProvider(ENV)
          .useValue(env)
          .compile();
        const app = moduleRef.createNestApplication<NestFastifyApplication>(
          new FastifyAdapter({ logger: false }),
        );
        const pools = app.get(ApplicationDatabasePools),
          metrics = app.get(MetricsService);
        configureHttpApp(app, { metrics });
        const borrowed: Array<Awaited<ReturnType<typeof acquire>>> = [];
        async function acquire() {
          return pools.primaryPool.connect();
        }
        const counter = async (operation: string, status: string) =>
          (await metrics.dbQueriesTotal.get()).values.find(
            (value) =>
              value.labels.operation === operation &&
              value.labels.status === status,
          )?.value ?? 0;
        try {
          await app.init();
          await app.getHttpAdapter().getInstance().ready();
          expect(pools.primaryPool).toBeInstanceOf(Pool);
          expect(pools.competitorPool).toBeInstanceOf(Pool);
          expect(
            (await pools.primaryPool.query('SELECT 7 AS value')).rows,
          ).toEqual([{ value: 7 }]);
          await expect(
            pools.competitorPool.query('SELECT 1 / 0'),
          ).rejects.toMatchObject({ code: '22012' });
          expect(await counter('SELECT', 'success')).toBe(1);
          expect(await counter('SELECT', 'error')).toBe(1);
          const histogram = await metrics.dbQueryDurationSeconds.get();
          expect(
            histogram.values.find(
              (value) =>
                value.metricName?.endsWith('_count') &&
                value.labels.operation === 'SELECT',
            )?.value,
          ).toBe(1);
          const config = {
            text: 'SELECT $1::int AS value',
            values: [11],
            name: 'metrics_private_prepared',
            rowMode: 'array' as const,
            types: {
              getTypeParser: (oid: number, format?: 'text' | 'binary') =>
                oid === 23
                  ? (value: string) => `parsed:${value}`
                  : types.getTypeParser(oid, format),
            },
          };
          expect((await pools.competitorPool.query(config)).rows).toEqual([
            ['parsed:11'],
          ]);
          expect(config.values).toEqual([11]);
          const client = await pools.primaryPool.connect();
          try {
            expect(client).toBeInstanceOf(Client);
            const callbackConfig = {
              text: 'SELECT 31 AS value',
              callback: undefined as
                | ((error: unknown, value: unknown) => void)
                | undefined,
            };
            await new Promise<void>((resolve, reject) => {
              const callback = (error: unknown, result: unknown) => {
                if (error) return reject(error);
                try {
                  expect(result).toMatchObject({ rows: [{ value: 31 }] });
                  resolve();
                } catch (failure) {
                  reject(failure);
                }
              };
              client.query(callbackConfig, callback);
              expect(callbackConfig.callback).toBe(callback);
            });
            await new Promise<void>((resolve, reject) => {
              const returned = client.query(
                'SELECT $1::int AS value',
                [13],
                (error, result) => {
                  if (error) return reject(error);
                  try {
                    expect(result.rows).toEqual([{ value: 13 }]);
                    resolve();
                  } catch (failure) {
                    reject(failure);
                  }
                },
              );
              expect(returned).toBeUndefined();
            });
            await client.query('BEGIN');
            await client.query(
              'CREATE TEMP TABLE neo_metrics_private(value int) ON COMMIT DROP',
            );
            await client.query('INSERT INTO neo_metrics_private VALUES(1)');
            await client.query('UPDATE neo_metrics_private SET value=2');
            await client.query('DELETE FROM neo_metrics_private');
            await client.query('ROLLBACK');
            await expect(
              client.query('SELECT * FROM neo_metrics_private'),
            ).rejects.toMatchObject({ code: '42P01' });
          } finally {
            client.release();
          }
          expect(() => client.release()).toThrow();
          await pools.primaryDb.transaction(async (transaction) => {
            await transaction.execute('SELECT 17');
          });
          const rollback = new Error('synthetic rollback');
          await expect(
            pools.competitorDb.transaction(async (transaction) => {
              await transaction.execute('SELECT 19');
              throw rollback;
            }),
          ).rejects.toBe(rollback);
          const beforeBatch = await counter('SELECT', 'success');
          await pools.primaryPool.query('SELECT 21; SELECT 23');
          expect(await counter('SELECT', 'success')).toBe(beforeBatch + 1);
          const beforeFailure = await counter('SELECT', 'error');
          const timeoutQuery = {
            text: 'SELECT pg_sleep(0.1)',
            query_timeout: 15,
          };
          await expect(pools.primaryPool.query(timeoutQuery)).rejects.toThrow(
            'Query read timeout',
          );
          expect(await counter('SELECT', 'error')).toBe(beforeFailure + 1);
          await pools.primaryPool.query('SELECT 29');
          for (let index = 0; index < 10; index++)
            borrowed.push(await acquire());
          const before = await metrics.dbQueriesTotal.get();
          const response = await app
            .getHttpAdapter()
            .getInstance()
            .inject({ method: 'GET', url: '/metrics' });
          expect(response.statusCode).toBe(200);
          expect(response.body).toContain(
            'amazon_asin_monitor_db_pool_active_connections{database="database"} 10',
          );
          expect(response.body).toContain(
            'amazon_asin_monitor_db_pool_connection_limit{database="competitor_database"} 10',
          );
          expect(await metrics.dbQueriesTotal.get()).toEqual(before);
          for (const privateText of [
            'neo_metrics_private',
            'metrics_private_prepared',
            env.DATABASE_URL,
            env.COMPETITOR_DATABASE_URL,
          ])
            expect(response.body).not.toContain(privateText);
          const pending = acquire();
          const first = borrowed.pop()!;
          first.release(true);
          const replacement = await pending;
          borrowed.push(replacement);
          expect(replacement).not.toBe(first);
          for (const value of (await metrics.dbQueriesTotal.get()).values) {
            expect(value.labels.table).toBe('unknown');
            expect(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'OTHER']).toContain(
              value.labels.operation,
            );
            expect(['success', 'error']).toContain(value.labels.status);
          }
        } finally {
          for (const client of borrowed) client.release();
          await app.close();
        }
      }, 30_000);
    },
  );
}
