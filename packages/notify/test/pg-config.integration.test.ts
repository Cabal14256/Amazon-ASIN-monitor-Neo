import {
  createPgPool,
  PgFeishuNotificationConfigReader,
} from '@asin-monitor/db';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { PgNotificationConfigSource } from '../src/pg-config-source';
import { FeishuNotifications } from '../src/service';
import { NodeFeishuTransport } from '../src/transport';
import type { NotificationDomain } from '../src/types';

type Pool = ReturnType<typeof createPgPool>;
const migration = readFileSync(
  resolve(
    __dirname,
    '../../db/migrations/0009_notification_country_collation.sql',
  ),
  'utf8',
);
const rollback = readFileSync(
  resolve(
    __dirname,
    '../../db/migrations/0009_notification_country_collation.rollback.sql',
  ),
  'utf8',
);
describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'notification configuration / actual D6 PostgreSQL and HTTP',
  () => {
    let primaryAdmin: Pool, competitorAdmin: Pool;
    let pools: Record<NotificationDomain, Pool>,
      schema: string,
      source: PgNotificationConfigSource;
    let authority: 'postgresql' | 'legacy-mysql';
    const table = {
      primary: 'feishu_config',
      competitor: 'competitor_feishu_config',
    };
    beforeAll(async () => {
      if (
        process.env.INTEGRATION_ALLOW_DROP_DATABASES !== 'true' ||
        !process.env.DATABASE_URL ||
        !process.env.COMPETITOR_DATABASE_URL
      )
        throw new Error(
          'Disposable D6 integration databases must be explicitly enabled',
        );
      primaryAdmin = createPgPool(process.env.DATABASE_URL, {
        max: 2,
        connectionTimeoutMillis: 2000,
      });
      competitorAdmin = createPgPool(process.env.COMPETITOR_DATABASE_URL, {
        max: 2,
        connectionTimeoutMillis: 2000,
      });
      const primary = (
        await primaryAdmin.query('SELECT current_database() AS name')
      ).rows[0].name;
      const competitor = (
        await competitorAdmin.query('SELECT current_database() AS name')
      ).rows[0].name;
      expect(primary).not.toBe(competitor);
      for (const pool of [primaryAdmin, competitorAdmin]) {
        const definition = (
          await pool.query(
            "SELECT collprovider,collisdeterministic,colliculocale FROM pg_collation WHERE oid='public.neo_notification_country_ci'::regcollation",
          )
        ).rows[0];
        expect(definition).toMatchObject({
          collprovider: 'i',
          collisdeterministic: false,
          colliculocale: 'und-u-ks-level1',
        });
      }
    });
    afterAll(async () => {
      await Promise.all([primaryAdmin?.end(), competitorAdmin?.end()]);
    });
    beforeEach(async () => {
      schema = `notify_117_${randomUUID().replace(/-/g, '')}`;
      for (const [domain, admin] of [
        ['primary', primaryAdmin],
        ['competitor', competitorAdmin],
      ] as const) {
        await admin.query(`CREATE SCHEMA "${schema}"`);
        await admin.query(
          `CREATE TABLE "${schema}".${table[domain]} (LIKE public.${table[domain]} INCLUDING ALL)`,
        );
      }
      const scoped = (connectionString: string) => {
        const url = new URL(connectionString);
        url.searchParams.set('options', `-c search_path=${schema}`);
        return createPgPool(url.toString(), {
          max: 4,
          connectionTimeoutMillis: 2000,
        });
      };
      pools = {
        primary: scoped(process.env.DATABASE_URL!),
        competitor: scoped(process.env.COMPETITOR_DATABASE_URL!),
      };
      authority = 'postgresql';
      source = new PgNotificationConfigSource({
        primaryPool: pools.primary,
        competitorPool: pools.competitor,
        authority: () => authority,
      });
      for (const pool of Object.values(pools))
        expect(
          (await pool.query('SELECT current_schema() AS name')).rows[0].name,
        ).toBe(schema);
    });
    afterEach(async () => {
      source?.close();
      try {
        if (pools)
          await Promise.all(Object.values(pools).map((pool) => pool.end()));
      } finally {
        if (!/^notify_117_[0-9a-f]{32}$/.test(schema))
          throw new Error('Unsafe notification fixture schema');
        await Promise.all([
          primaryAdmin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`),
          competitorAdmin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`),
        ]);
      }
    });
    const read = (
      domain: NotificationDomain,
      region = 'US',
      signal = new AbortController().signal,
    ) => source.read(domain, region, signal);
    const seed = (
      domain: NotificationDomain,
      country = 'US',
      enabled: boolean | null = true,
      url = `https://example.invalid/private-${domain}-117`,
    ) =>
      pools[domain].query(
        `INSERT INTO ${table[domain]}(country,webhook_url,enabled) VALUES($1,$2,$3)`,
        [country, url, enabled],
      );
    it('keeps primary and competitor database/credential identities separate', async () => {
      await seed('primary');
      await seed('competitor');
      expect(await read('primary')).toEqual({
        webhookUrl: 'https://example.invalid/private-primary-117',
      });
      expect(await read('competitor')).toEqual({
        webhookUrl: 'https://example.invalid/private-competitor-117',
      });
      await pools.primary.query('DELETE FROM feishu_config');
      expect(await read('primary')).toBeUndefined();
      expect(await read('competitor')).toHaveProperty(
        'webhookUrl',
        'https://example.invalid/private-competitor-117',
      );
    });
    for (const domain of ['primary', 'competitor'] as const) {
      it(`${domain} observes committed rotation, disable/null, deletion and empty configuration`, async () => {
        expect(await read(domain)).toBeUndefined();
        await seed(domain);
        for (const enabled of [false, null, true]) {
          await pools[domain].query(
            `UPDATE ${table[domain]} SET webhook_url=$1,enabled=$2`,
            ['https://example.invalid/rotated-117', enabled],
          );
          expect(await read(domain)).toEqual(
            enabled === true
              ? { webhookUrl: 'https://example.invalid/rotated-117' }
              : undefined,
          );
        }
        await pools[domain].query(`UPDATE ${table[domain]} SET webhook_url=''`);
        expect(await read(domain)).toEqual({ webhookUrl: '' });
        await pools[domain].query(`DELETE FROM ${table[domain]}`);
        expect(await read(domain)).toBeUndefined();
      });
      it(`${domain} uses CI/accent/PADSPACE equality and raw-region lookup without automatic EU mapping`, async () => {
        await seed(domain, 'ús ');
        await seed(domain, 'EU', true, 'https://example.invalid/eu-117');
        for (const region of ['US', 'us', 'ÚS ', 'ús'])
          expect(await read(domain, region)).toHaveProperty(
            'webhookUrl',
            `https://example.invalid/private-${domain}-117`,
          );
        expect(await read(domain, 'UK')).toBeUndefined();
        expect(await read(domain, 'EU')).toHaveProperty(
          'webhookUrl',
          'https://example.invalid/eu-117',
        );
      });
      it(`${domain} fails closed on ambiguous equivalent country rows even when one is disabled`, async () => {
        await seed(domain);
        await seed(
          domain,
          'US ',
          false,
          'https://example.invalid/duplicate-117',
        );
        const error = await read(domain).catch((error) => error as Error);
        expect(error).toMatchObject({ reason: 'invalid-result' });
        expect(String(error)).not.toContain('example.invalid');
      });
      it(`${domain} stops a blocked SQL query on cancellation and recovers its pool`, async () => {
        await seed(domain);
        const blocker = await pools[domain].connect();
        try {
          await blocker.query('BEGIN');
          await blocker.query(
            `LOCK TABLE ${table[domain]} IN ACCESS EXCLUSIVE MODE`,
          );
          const abort = new AbortController(),
            pending = read(domain, 'US', abort.signal);
          const rejected = expect(pending).rejects.toMatchObject({
            reason: 'cancelled',
          });
          await vi.waitFor(
            async () => {
              const locks = await blocker.query(
                'SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND pg_backend_pid()=ANY(pg_blocking_pids(pid))',
              );
              expect(locks.rows[0].n).toBeGreaterThan(0);
            },
            { timeout: 1000, interval: 10 },
          );
          const start = Date.now();
          abort.abort('private reason');
          await rejected;
          expect(Date.now() - start).toBeLessThan(1000);
        } finally {
          await blocker.query('ROLLBACK');
          blocker.release();
        }
        expect(await read(domain)).toHaveProperty(
          'webhookUrl',
          `https://example.invalid/private-${domain}-117`,
        );
      });
    }
    it('observes rotation committed while waiting for the primary administration lock without blocking competitor reads', async () => {
      await seed('primary');
      await seed('competitor');
      const blocker = await pools.primary.connect();
      let pending: ReturnType<typeof read> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'SELECT pg_advisory_xact_lock(1095977294,1380073795)',
        );
        pending = read('primary');
        await vi.waitFor(
          async () => {
            const locks = await blocker.query(
              "SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND pg_backend_pid()=ANY(pg_blocking_pids(pid))",
            );
            expect(locks.rows[0].n).toBeGreaterThan(0);
          },
          { timeout: 1000, interval: 10 },
        );
        expect(await read('competitor')).toHaveProperty('webhookUrl');
        await blocker.query(
          "UPDATE feishu_config SET webhook_url='https://example.invalid/committed-rotation-117'",
        );
        await blocker.query('COMMIT');
        expect(await pending).toEqual({
          webhookUrl: 'https://example.invalid/committed-rotation-117',
        });
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        if (pending) await pending.catch(() => {});
      }
    });
    it('fails before reading in Legacy authority mode and never falls back to a previous credential after SQL failure', async () => {
      await seed('primary');
      expect(await read('primary')).toHaveProperty('webhookUrl');
      authority = 'legacy-mysql';
      await expect(read('primary')).rejects.toMatchObject({
        reason: 'dependency',
      });
      authority = 'postgresql';
      await pools.primary.query('DROP TABLE feishu_config');
      await expect(read('primary')).rejects.toMatchObject({
        reason: 'dependency',
      });
    });
    it('bounds oversized out-of-band values without returning a truncated credential', async () => {
      await pools.primary.query(
        'ALTER TABLE feishu_config ALTER COLUMN webhook_url TYPE text',
      );
      await seed('primary', 'US', true, 'x'.repeat(100_000));
      await expect(read('primary')).rejects.toMatchObject({
        reason: 'invalid-result',
      });
    });
    it('honors the actual SQL deadline and drops failed connections without leaking configuration', async () => {
      await seed('primary');
      const blocker = await pools.primary.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'LOCK TABLE feishu_config IN ACCESS EXCLUSIVE MODE',
        );
        const start = Date.now(),
          error = await read('primary').catch((error) => error as Error);
        expect(error).toMatchObject({
          reason: expect.stringMatching(/dependency|timeout/),
        });
        expect(Date.now() - start).toBeLessThan(3000);
        expect(String(error)).not.toContain('feishu_config');
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      expect(await read('primary')).toHaveProperty('webhookUrl');
    });
    it('uses committed PostgreSQL rotation for the second real HTTP attempt and respects subsequent disable', async () => {
      let endpoint = '',
        requests = 0;
      const paths: string[] = [];
      const server = http.createServer((request, response) => {
        requests++;
        paths.push(request.url!);
        void (async () => {
          if (requests === 1)
            await pools.primary.query(
              'UPDATE feishu_config SET webhook_url=$1',
              [`${endpoint}/rotated`],
            );
          response.end(requests === 1 ? '{"code":11232}' : '{"code":0}');
        })().catch(() => {
          response.statusCode = 500;
          response.end();
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      await seed('primary', 'EU', true, `${endpoint}/initial`);
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const transport = new NodeFeishuTransport({ allowLocalHttp: true });
      const service = new FeishuNotifications({
        source,
        transport,
        logger: log,
        delay: async () => {},
      });
      try {
        expect(
          await service.sendCountry('primary', 'UK', { checkTime: 'fixture' }),
        ).toEqual({ success: true, skipped: false });
        expect(paths).toEqual(['/initial', '/rotated']);
        await pools.primary.query('UPDATE feishu_config SET enabled=false');
        expect(await service.sendCountry('primary', 'UK', {})).toEqual({
          success: false,
          skipped: false,
          errorCode: undefined,
        });
        expect(requests).toBe(2);
        expect(
          JSON.stringify([
            log.info.mock.calls,
            log.warn.mock.calls,
            log.error.mock.calls,
          ]),
        ).not.toContain(endpoint);
      } finally {
        service.close();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
    it('applies/verifies/rolls back the actual migration repeatedly and rejects an incompatible existing collation', async () => {
      const database = `notify_collation_117_${randomUUID().replace(/-/g, '')}`;
      if (!/^notify_collation_117_[0-9a-f]{32}$/.test(database))
        throw new Error('Unsafe fixture database');
      await primaryAdmin.query(`CREATE DATABASE "${database}"`);
      const url = new URL(process.env.DATABASE_URL!);
      url.pathname = `/${database}`;
      const pool = createPgPool(url.toString(), {
        max: 1,
        connectionTimeoutMillis: 2000,
      });
      try {
        await pool.query(migration);
        await pool.query(migration);
        expect(
          (
            await pool.query(
              "SELECT 'ús '::text COLLATE public.neo_notification_country_ci = 'US ' AS equal",
            )
          ).rows[0].equal,
        ).toBe(true);
        await pool.query(rollback);
        await pool.query(rollback);
        expect(
          (
            await pool.query(
              "SELECT to_regcollation('public.neo_notification_country_ci') AS value",
            )
          ).rows[0].value,
        ).toBeNull();
        await pool.query(
          "CREATE COLLATION public.neo_notification_country_ci (provider=icu,locale='und-u-ks-level3',deterministic=true)",
        );
        await expect(pool.query(migration)).rejects.toThrow(
          'Notification country collation definition or ICU version differs',
        );
        await pool.query('ROLLBACK');
        await pool.query(rollback);
        const reader = new PgFeishuNotificationConfigReader(pool, 'primary');
        try {
          await expect(reader.read('US')).rejects.toMatchObject({
            reason: 'dependency',
          });
        } finally {
          reader.close();
        }
      } finally {
        await pool.end();
        await primaryAdmin.query(`DROP DATABASE "${database}"`);
      }
    });
  },
);
