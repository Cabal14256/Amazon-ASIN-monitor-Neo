import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
import {
  feishuConfigurationLegacy,
  type FeishuLegacyOperation,
} from '../../../packages/db/test/helpers/feishu-configuration-legacy';
import { legacyAnalyticsFixture } from '../../../packages/db/test/helpers/monitor-analytics-legacy';
import { FeishuConfigModule } from '../src/feishu-config/feishu-config.module';
import { spApiConfigApp } from './helpers/sp-api-config-app';

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'Feishu configuration / actual Legacy MySQL controller and Neo PostgreSQL HTTP',
  () => {
    let f: Awaited<ReturnType<typeof spApiConfigApp>>;
    let legacy: Awaited<ReturnType<typeof legacyAnalyticsFixture>>;
    let oracle: ReturnType<typeof feishuConfigurationLegacy>;
    let operator: Awaited<ReturnType<typeof user>>;
    let startedAt: number;
    const webhook = 'https://example.invalid/private-feishu-115';
    beforeAll(async () => {
      legacy = await legacyAnalyticsFixture();
      const ddl = readFileSync(
        resolve(__dirname, '../../../server/database/init.sql'),
        'utf8',
      );
      const statement = ddl.match(
        /CREATE TABLE IF NOT EXISTS `feishu_config`[\s\S]*?ENGINE=InnoDB[^;]*;/,
      )?.[0];
      if (!statement) throw new Error('Legacy Feishu DDL is missing');
      await legacy.query(
        statement.replace(
          'DEFAULT CHARSET=utf8mb4',
          'DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci',
        ),
      );
      oracle = feishuConfigurationLegacy(legacy.query);
    });
    afterAll(async () => {
      if (legacy) await legacy.close();
    });
    beforeEach(async () => {
      startedAt = Date.now();
      f = await spApiConfigApp({ imports: [FeishuConfigModule] });
      await f.redis.ping();
      await f.pools.primaryPool.query(
        'CREATE TABLE feishu_config (LIKE public.feishu_config INCLUDING ALL)',
      );
      // LIKE does not copy triggers: exercise the real baseline timestamp trigger.
      await f.pools.primaryPool.query(
        "CREATE TRIGGER trg_feishu_config_update_time BEFORE UPDATE ON feishu_config FOR EACH ROW EXECUTE FUNCTION public.set_updated_timestamp_column('update_time')",
      );
      expect(
        (await f.pools.primaryPool.query('SHOW TIMEZONE')).rows[0].TimeZone,
      ).toBe('Asia/Shanghai');
      await legacy.query('TRUNCATE TABLE feishu_config');
      operator = await user();
    });
    afterEach(async () => {
      try {
        if (f) await f.close();
      } finally {
        vi.restoreAllMocks();
      }
    });
    async function user(role = 'writer-71') {
      const userId = randomUUID(),
        sessionId = randomUUID();
      f.userIds.add(userId);
      await f.pools.primaryPool.query(
        'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$1,$2,false)',
        [userId, 'fixture-unused-hash'],
      );
      await f.pools.primaryPool.query(
        'INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)',
        [userId, role],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,'2099-01-01 08:00:00')",
        [sessionId, userId],
      );
      return {
        userId,
        sessionId,
        headers: {
          authorization: `Bearer ${jwt.sign(
            { userId, sessionId },
            f.env.JWT_SECRET,
            { expiresIn: '1h' },
          )}`,
        },
      };
    }
    const request = (
      method: Method,
      country?: string,
      payload?: object,
      headers: Record<string, string> = operator.headers,
    ) =>
      f.http.inject({
        method,
        url: `/api/v1/feishu-configs${
          country === undefined ? '' : `/${encodeURIComponent(country)}`
        }${method === 'PATCH' ? '/toggle' : ''}`,
        headers,
        ...(payload === undefined ? {} : { payload }),
      });
    // Only newly generated database times are compared as bounded current times.
    // MySQL DATETIME(0) and the baseline PostgreSQL trigger have different precision
    // and run on separate clocks; historical timestamps/nulls remain byte-exact.
    function canonical(value: unknown): unknown {
      return JSON.parse(JSON.stringify(value), (key, item) => {
        if (
          !['createTime', 'updateTime', 'create_time', 'update_time'].includes(
            key,
          ) ||
          item === null
        )
          return item;
        expect(item).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        const time = Date.parse(item);
        expect(Number.isFinite(time)).toBe(true);
        if (time >= startedAt - 1000) {
          expect(time).toBeLessThanOrEqual(Date.now() + 1000);
          return '[validated current database time]';
        }
        return item;
      });
    }
    const pgRows = async () =>
      (
        await f.pools.primaryPool.query(
          "SELECT id,country,webhook_url,CASE WHEN enabled THEN 1 WHEN NOT enabled THEN 0 ELSE NULL END AS enabled,create_time AT TIME ZONE 'Asia/Shanghai' AS create_time,update_time AT TIME ZONE 'Asia/Shanghai' AS update_time FROM feishu_config ORDER BY id",
        )
      ).rows;
    const mysqlRows = () =>
      legacy.query('SELECT * FROM feishu_config ORDER BY id');
    async function seed(country = 'US', enabled: number | null = 1) {
      await legacy.query(
        "INSERT INTO feishu_config(country,webhook_url,enabled,create_time,update_time) VALUES(?,?,?,'2024-02-29 00:00:00',NULL)",
        [country, webhook, enabled],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO feishu_config(country,webhook_url,enabled,create_time,update_time) VALUES($1,$2,$3,'2024-02-29 00:00:00',NULL)",
        [country, webhook, enabled === null ? null : !!enabled],
      );
    }
    async function compare(method: Method, country?: string, payload?: object) {
      const operation: FeishuLegacyOperation =
        method === 'GET'
          ? country === undefined
            ? 'getFeishuConfigs'
            : 'getFeishuConfigByCountry'
          : method === 'DELETE'
          ? 'deleteFeishuConfig'
          : method === 'PATCH'
          ? 'toggleFeishuConfig'
          : 'upsertFeishuConfig';
      const actual = await request(method, country, payload),
        expected = await oracle(operation, payload, country);
      expect(actual.statusCode).toBe(expected.statusCode);
      expect(actual.headers['cache-control']).toBe('no-store');
      expect(canonical(actual.json())).toEqual(canonical(expected.body));
      expect(canonical(await pgRows())).toEqual(canonical(await mysqlRows()));
      return actual;
    }
    it('matches empty/missing results and authenticates every route', async () => {
      await compare('GET');
      await compare('GET', 'US');
      await compare('DELETE', 'missing');
      for (const [method, country] of [
        ['GET', undefined],
        ['GET', 'US'],
        ['POST', undefined],
        ['PUT', 'US'],
        ['DELETE', 'US'],
        ['PATCH', 'US'],
      ] as const) {
        expect((await request(method, country, undefined, {})).statusCode).toBe(
          401,
        );
      }
    });
    it.each([null, 0, 1])(
      'preserves complete list/detail shapes, nullable flags, D8 dates and exact EU aliases (%s)',
      async (enabled) => {
        for (const country of ['EU', 'US', 'JP', 'UK'])
          await seed(country, enabled);
        const list = await compare('GET');
        expect(list.json().data).toHaveLength(2);
        expect(list.json().data[0].createTime).toBe('2024-02-28T16:00:00.000Z');
        for (const country of [
          'US',
          'EU',
          'UK',
          'DE',
          'FR',
          'IT',
          'ES',
          'uk',
          'UK ',
          'JP',
          'missing',
        ])
          await compare('GET', country);
      },
    );
    it('matches complete committed CRUD sequences including PUT body identity and disable-then-404', async () => {
      await compare('POST', undefined, { country: 'US', webhookUrl: webhook });
      await compare('PUT', 'US', {
        country: 'EU',
        webhookUrl: `${webhook}/eu`,
        enabled: 0,
      });
      await compare('GET', 'EU');
      await compare('PATCH', 'EU', { enabled: true });
      await compare('GET', 'UK');
      await compare('PATCH', 'UK', { enabled: false });
      await compare('POST', undefined, {
        country: 'UK',
        webhookUrl: `${webhook}/uk`,
        enabled: false,
      });
      await compare('PATCH', 'UK', { enabled: true });
      await compare('DELETE', 'UK');
      expect(
        (await compare('PATCH', 'EU', { enabled: false })).statusCode,
      ).toBe(404);
      expect(
        (await pgRows()).find((row) => row.country === 'EU')?.enabled,
      ).toBe(0);
      await compare('GET', 'UK');
      await compare('DELETE', 'EU');
      await compare('DELETE', 'EU');
    });
    it.each(['us ', 'ÚS'])(
      'preserves migrated country label and identity using Legacy CI/PADSPACE equality (%s)',
      async (country) => {
        await seed(country);
        await compare('GET');
        await compare('GET', 'US');
        const update = await compare('POST', undefined, {
          country: 'US',
          webhookUrl: `${webhook}/changed`,
        });
        expect(update.json().data).toMatchObject({ id: 1, country });
        await compare('PATCH', 'uS ', { enabled: 0 });
        await compare('DELETE', 'US');
      },
    );
    it('masks webhooks for current read-only grants and denies writes without modifying storage', async () => {
      await seed();
      const reader = await user('reader-71'),
        before = await pgRows();
      const list = await request('GET', undefined, undefined, reader.headers),
        detail = await request('GET', 'US', undefined, reader.headers);
      expect(list.statusCode).toBe(200);
      expect(detail.statusCode).toBe(200);
      expect(list.json().data[0].webhookUrl).toBe('***REDACTED***');
      expect(detail.json().data.webhook_url).toBe('***REDACTED***');
      expect(
        (
          await request(
            'POST',
            undefined,
            { country: 'US', webhookUrl: `${webhook}/denied` },
            reader.headers,
          )
        ).statusCode,
      ).toBe(403);
      expect(await pgRows()).toEqual(before);
    });
    it.each(['permission', 'account', 'password', 'session', 'session-expiry'])(
      'rejects cached authentication after current %s changes',
      async (kind) => {
        await seed();
        await compare('GET');
        const before = await pgRows();
        const query =
          kind === 'permission'
            ? 'DELETE FROM user_roles WHERE user_id=$1'
            : kind === 'account'
            ? "UPDATE users SET status='SUSPENDED' WHERE id=$1"
            : kind === 'password'
            ? 'UPDATE users SET force_password_change=true WHERE id=$1'
            : kind === 'session'
            ? "UPDATE sessions SET status='REVOKED' WHERE user_id=$1"
            : "UPDATE sessions SET expires_at='2000-01-01 08:00:00' WHERE user_id=$1";
        await f.pools.primaryPool.query(query, [operator.userId]);
        expect((await request('GET')).statusCode).toBe(
          kind === 'session-expiry' ? 401 : 403,
        );
        expect(
          (
            await request('POST', undefined, {
              country: 'US',
              webhookUrl: `${webhook}/denied`,
            })
          ).statusCode,
        ).toBe(403);
        expect(await pgRows()).toEqual(before);
      },
    );
    it('waits for the administration lock and authorizes against the committed revocation', async () => {
      await seed();
      await compare('GET');
      const before = await pgRows(),
        connection = await f.pools.primaryPool.connect();
      let pending: ReturnType<typeof request> | undefined;
      try {
        await connection.query('BEGIN');
        await connection.query(
          'SELECT pg_advisory_xact_lock(1095977294,1380073795)',
        );
        pending = request('POST', undefined, {
          country: 'US',
          webhookUrl: `${webhook}/denied`,
        });
        // Start injection now; LightMyRequest otherwise defers dispatch until await.
        const response = Promise.resolve(pending);
        await vi.waitFor(
          async () => {
            const waiting = await connection.query(
              "SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND NOT granted AND pg_backend_pid()=ANY(pg_blocking_pids(pid))",
            );
            expect(waiting.rows[0].count).toBeGreaterThan(0);
          },
          { timeout: 1000, interval: 10 },
        );
        await connection.query('DELETE FROM user_roles WHERE user_id=$1', [
          operator.userId,
        ]);
        await connection.query('COMMIT');
        expect((await response).statusCode).toBe(403);
        expect(await pgRows()).toEqual(before);
      } finally {
        await connection.query('ROLLBACK');
        connection.release();
        if (pending) await pending;
      }
    });
    it('serializes equivalent concurrent inserts to one identity', async () => {
      const users = await Promise.all([user(), user(), user()]);
      const results = await Promise.all(
        ['US', 'us', 'US '].map((country, i) =>
          request(
            'POST',
            undefined,
            { country, webhookUrl: `${webhook}/${i}` },
            users[i]!.headers,
          ),
        ),
      );
      expect(results.map((result) => result.statusCode)).toEqual([
        200, 200, 200,
      ]);
      expect(new Set(results.map((result) => result.json().data.id)).size).toBe(
        1,
      );
      const rows = await pgRows();
      expect(rows).toHaveLength(1);
      expect([`${webhook}/0`, `${webhook}/1`, `${webhook}/2`]).toContain(
        rows[0].webhook_url,
      );
    });
    it('rolls back SQL failures and redacts audit, logger and error responses', async () => {
      await seed();
      const before = await pgRows(),
        rejected = `${webhook}/reject-private-fixture-115`;
      await f.pools.primaryPool.query(
        "CREATE FUNCTION reject_feishu_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.webhook_url LIKE '%reject-private-fixture-115%' THEN RAISE EXCEPTION 'reject-private-fixture-115'; END IF; RETURN NEW; END $$",
      );
      await f.pools.primaryPool.query(
        'CREATE TRIGGER reject_feishu_fixture AFTER INSERT OR UPDATE ON feishu_config FOR EACH ROW EXECUTE FUNCTION reject_feishu_fixture()',
      );
      const result = await request('POST', undefined, {
        country: 'US',
        webhookUrl: rejected,
      });
      expect(result.statusCode).toBe(500);
      expect(await pgRows()).toEqual(before);
      await f.audit.flush();
      const audits = (
        await f.pools.primaryPool.query(
          'SELECT action,request_data,response_status,error_message FROM audit_logs WHERE user_id=$1',
          [operator.userId],
        )
      ).rows;
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        action: 'UPDATE',
        response_status: 500,
        request_data: { webhookUrl: '***REDACTED***' },
      });
      const exposed = JSON.stringify([
        audits,
        f.logger.error.mock.calls,
        result.body,
      ]);
      expect(exposed).not.toContain(webhook);
      expect(exposed).not.toContain('reject-private-fixture-115');
      await compare('GET', 'US');
    });
    it('audits successful writes, committed disable-404 and idempotent deletes without webhooks', async () => {
      await compare('POST', undefined, { country: 'US', webhookUrl: webhook });
      await compare('PATCH', 'US', { enabled: false });
      await compare('DELETE', 'US');
      await f.audit.flush();
      const rows = (
        await f.pools.primaryPool.query(
          'SELECT action,method,resource_id,request_data,response_status FROM audit_logs WHERE user_id=$1 ORDER BY create_time,id',
          [operator.userId],
        )
      ).rows;
      expect(
        rows.map((row) => [
          row.action,
          row.method,
          row.resource_id,
          row.response_status,
        ]),
      ).toEqual([
        ['UPDATE', 'POST', null, 200],
        ['UPDATE', 'PATCH', 'US', 404],
        ['DELETE', 'DELETE', 'US', 200],
      ]);
      expect(rows[0].request_data.webhookUrl).toBe('***REDACTED***');
      expect(JSON.stringify(rows)).not.toContain(webhook);
    });
    it('bounds real SQL lock waits, releases failed transactions and recovers', async () => {
      await seed();
      const before = await pgRows(),
        connection = await f.pools.primaryPool.connect();
      try {
        await connection.query('BEGIN');
        await connection.query(
          'LOCK TABLE feishu_config IN ACCESS EXCLUSIVE MODE',
        );
        const start = Date.now(),
          result = await request('POST', undefined, {
            country: 'US',
            webhookUrl: `${webhook}/blocked`,
          });
        expect(result.statusCode).toBe(500);
        expect(Date.now() - start).toBeLessThan(5000);
        expect(result.body).not.toContain('feishu_config');
      } finally {
        await connection.query('ROLLBACK');
        connection.release();
      }
      expect(await pgRows()).toEqual(before);
      await compare('GET', 'US');
    });
    it('fails closed on out-of-band PADSPACE duplicates which Legacy unique country rejects', async () => {
      await seed();
      await expect(
        legacy.query(
          'INSERT INTO feishu_config(country,webhook_url) VALUES(?,?)',
          ['US ', `${webhook}/duplicate`],
        ),
      ).rejects.toMatchObject({ code: 'ER_DUP_ENTRY' });
      await f.pools.primaryPool.query(
        'INSERT INTO feishu_config(country,webhook_url) VALUES($1,$2)',
        ['US ', `${webhook}/duplicate`],
      );
      for (const country of [undefined, 'US']) {
        const result = await request('GET', country);
        expect(result.statusCode).toBe(500);
        expect(result.body).not.toContain(webhook);
      }
    });
  },
);
