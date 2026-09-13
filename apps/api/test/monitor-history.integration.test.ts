import {
  monitorHistoryDetailResultSchema,
  monitorHistoryListResultSchema,
} from '@asin-monitor/contracts';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { MonitorHistoryModule } from '../src/monitor/monitor-history.module';
import { legacyMonitorHistoryFixture } from './helpers/monitor-history-legacy';
import { spApiConfigApp } from './helpers/sp-api-config-app';

// JSONB preserves the entire value, not Legacy TEXT's whitespace/key order.
// Compare both complete JSON values while retaining every other response field.
function canonical(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value), (key, item) =>
    (key === 'check_result' || key === 'checkResult') &&
    typeof item === 'string'
      ? JSON.parse(item)
      : item,
  );
}
describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'monitor history / real Legacy MySQL and Neo PostgreSQL HTTP',
  () => {
    let f: Awaited<ReturnType<typeof spApiConfigApp>>;
    let legacy: Awaited<ReturnType<typeof legacyMonitorHistoryFixture>>;
    let userId: string, sessionId: string, headers: { authorization: string };
    beforeAll(async () => {
      legacy = await legacyMonitorHistoryFixture();
      f = await spApiConfigApp({ imports: [MonitorHistoryModule] });
      for (const table of ['variant_groups', 'asins', 'monitor_history'])
        await f.pools.primaryPool.query(
          `CREATE TABLE "${table}" (LIKE public."${table}" INCLUDING ALL)`,
        );
      await f.pools.primaryPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT 'reader-71',id FROM permissions WHERE code='monitor:read'",
      );
    });
    afterAll(async () => {
      try {
        if (f) await f.close();
      } finally {
        if (legacy) await legacy.close();
        vi.restoreAllMocks();
      }
    });
    beforeEach(async () => {
      for (const table of ['monitor_history', 'asins', 'variant_groups']) {
        await f.pools.primaryPool.query(`DELETE FROM "${table}"`);
        await legacy.query(`DELETE FROM \`${table}\``);
      }
      userId = randomUUID();
      sessionId = randomUUID();
      f.userIds.add(userId);
      await f.pools.primaryPool.query(
        'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$1,$2,false)',
        [userId, 'fixture-unused-hash'],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO user_roles(user_id,role_id) VALUES($1,'reader-71')",
        [userId],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,'2099-01-01 08:00:00')",
        [sessionId, userId],
      );
      headers = {
        authorization: `Bearer ${jwt.sign(
          { userId, sessionId },
          f.env.JWT_SECRET,
          { expiresIn: '1h' },
        )}`,
      };
    });
    const get = (raw: Record<string, string> = {}) =>
      f.http.inject({
        method: 'GET',
        url: '/api/v1/monitor-history?' + new URLSearchParams(raw),
        headers,
      });
    const detail = (id: number) =>
      f.http.inject({
        method: 'GET',
        url: `/api/v1/monitor-history/${id}`,
        headers,
      });
    const compare = async (raw: Record<string, string>) => {
      const expected = await legacy.list(raw),
        actual = await get(raw);
      expect(expected.statusCode).toBe(200);
      expect(actual.statusCode).toBe(200);
      monitorHistoryListResultSchema.parse(actual.json());
      expect(canonical(actual.json())).toEqual(canonical(expected.body));
      expect(actual.headers['cache-control']).toBe('no-store');
      return actual.json().data;
    };
    async function seed() {
      for (const [id, name] of [
        ['g1', 'Current Résumé'],
        ['g2', 'Current second'],
      ]) {
        const values = [id, name];
        await legacy.query(
          "INSERT INTO variant_groups(id,name,country,site,brand) VALUES(?,?,'US','12','Fixture')",
          values,
        );
        await f.pools.primaryPool.query(
          "INSERT INTO variant_groups(id,name,country,site,brand) VALUES($1,$2,'US','12','Fixture')",
          values,
        );
      }
      const types = ['MAIN_LINK', '1', 'SUB_REVIEW', '2', 'custom', null];
      for (let i = 0; i < types.length; i++) {
        const values = [
          `a${i + 1}`,
          `B00000000${i + 1}`,
          `Current Product ${i + 1}`,
          types[i],
        ];
        await legacy.query(
          "INSERT INTO asins(id,asin,name,asin_type,country,site,brand,variant_group_id) VALUES(?,?,?,?,'US','12','Fixture','g1')",
          values,
        );
        await f.pools.primaryPool.query(
          "INSERT INTO asins(id,asin,name,asin_type,country,site,brand,variant_group_id) VALUES($1,$2,$3,$4,'US','12','Fixture','g1')",
          values,
        );
      }
      const names = [
        'Café 100%_done\\path',
        'Snapshot second',
        null,
        '',
        '删除快照😀',
        'Straße',
      ];
      for (let i = 0; i < 8; i++) {
        const values = [
          i + 1,
          i === 6 ? 'deleted-group' : i === 7 ? 'G1 ' : 'g1',
          i === 6 ? 'Retained group' : i === 2 ? null : 'Snapshot Résumé',
          i === 6 ? 'deleted-asin' : i === 7 ? 'A1 ' : `a${i + 1}`,
          i === 2 ? null : i === 3 ? '' : `B00000000${i + 1}`,
          names[i] ?? (i === 2 ? null : 'Retained product'),
          i === 7 ? null : i % 2 ? 'ASIN' : 'GROUP',
          ['US', 'UK', 'DE', 'FR', 'IT', 'ES', 'us ', 'JP'][i],
          i === 7 ? null : i % 2,
          '2026-09-13 08:00:00',
          i === 7
            ? null
            : JSON.stringify({
                index: i,
                nested: { values: [true, null, '原始结果'] },
                padding: 'x'.repeat(2500),
              }),
          i === 7 ? null : (i + 1) % 2,
          i === 7 ? null : '2026-09-13 08:30:00',
        ];
        const columns =
          'id,variant_group_id,variant_group_name,asin_id,asin_code,asin_name,check_type,country,is_broken,check_time,check_result,notification_sent,create_time';
        await legacy.query(
          `INSERT INTO monitor_history(${columns}) VALUES(${values
            .map(() => '?')
            .join(',')})`,
          values,
        );
        const pgValues = values.map((value, position) =>
          [8, 11].includes(position) && value !== null ? Boolean(value) : value,
        );
        await f.pools.primaryPool.query(
          `INSERT INTO monitor_history(${columns}) OVERRIDING SYSTEM VALUE VALUES(${values
            .map((_, pos) => '$' + (pos + 1))
            .join(',')})`,
          pgValues,
        );
      }
    }
    it('matches complete Legacy rows, nullable state and D8 dates on every detail', async () => {
      await seed();
      await compare({});
      for (let id = 1; id <= 8; id++) {
        const actual = await detail(id),
          expected = await legacy.detail(id);
        expect(actual.statusCode).toBe(expected.statusCode);
        monitorHistoryDetailResultSchema.parse(actual.json());
        expect(canonical(actual.json())).toEqual(canonical(expected.body));
      }
      expect((await detail(1)).json().data.checkTime).toBe(
        '2026-09-13T00:00:00.000Z',
      );
      expect((await detail(1000)).statusCode).toBe(404);
      expect(
        (await f.http.inject({ method: 'GET', url: '/api/v1/monitor-history' }))
          .statusCode,
      ).toBe(401);
    });
    it('matches the real controller/model filter matrix, wildcard escaping and aliases', async () => {
      await seed();
      const cases: Record<string, string>[] = [
        { variantGroupId: 'G1 ' },
        { asinId: 'A1 ' },
        { variantGroupId: 'deleted-group' },
        { country: 'US' },
        { country: 'us ' },
        { country: 'EU' },
        { country: 'eu' },
        { asin: '000000001' },
        { asin: 'b000000001,b000000002,b000000001' },
        { asin: 'B000000001\n B000000002' },
        { asin: ',,,' },
        { variantGroupName: 'resume' },
        { variantGroupName: 'CURRENT' },
        { variantGroupName: 'Retained' },
        { asinName: 'cafe' },
        { asinName: 'C_f%' },
        { asinName: '100\\%\\_done' },
        { asinName: '\\\\path' },
        { asinName: 'Straße' },
        { asinName: 'strasse' },
        { asinName: '删除_照_' },
        { asinType: '1' },
        { asinType: ' MAIN_LINK ' },
        { asinType: 'main_link' },
        { asinType: '2' },
        { asinType: 'SUB_REVIEW' },
        { asinType: 'custom' },
        { checkType: ' group ' },
        { isBroken: '1' },
        { isBroken: '0' },
        { isBroken: 'true' },
        {
          country: 'EU',
          checkType: 'ASIN',
          isBroken: '1',
          asinType: 'MAIN_LINK',
        },
        { startTime: '2026-09-13 08:00:00', endTime: '2026-09-13 08:00:00' },
        { endTime: '2026-09-13' },
        { startTime: '2026-09-14', endTime: '2026-09-12' },
        { asinName: "' OR 1=1 --" },
        { country: 'US%' },
        { current: '2', pageSize: '3' },
        { current: '100', pageSize: '3' },
      ];
      for (const raw of cases) await compare(raw);
      const first = await compare({ pageSize: '3' }),
        second = await compare({ pageSize: '3', current: '2' });
      expect(first.list.map((row: { id: number }) => row.id)).toEqual([
        8, 7, 6,
      ]);
      expect(second.list.map((row: { id: number }) => row.id)).toEqual([
        5, 4, 3,
      ]);
    });
    it('uses saved names/codes after deletion, NULL fallback before deletion, and never replaces empty snapshots', async () => {
      await seed();
      expect(
        (await compare({ asinName: 'Current' })).list.map(
          (row: { id: number }) => row.id,
        ),
      ).toEqual([3]);
      for (const table of ['asins', 'variant_groups']) {
        await legacy.query(`DELETE FROM \`${table}\``);
        await f.pools.primaryPool.query(`DELETE FROM "${table}"`);
      }
      await compare({});
      await compare({ asinName: 'Current' });
      await compare({ asinType: 'MAIN_LINK' });
      expect((await detail(3)).json().data.asin).toBeNull();
      expect((await detail(4)).json().data.asin).toBe('');
      expect((await detail(7)).json().data.asinName).toBe('Retained product');
    });
    it('rejects ambiguous parent IDs under the history reference collation', async () => {
      await seed();
      await expect(
        f.pools.primaryPool.query(
          "INSERT INTO variant_groups(id,name,country,site,brand) VALUES('G1 ','Duplicate','US','12','Fixture')",
        ),
      ).rejects.toMatchObject({ code: '23505' });
      await expect(
        f.pools.primaryPool.query(
          "INSERT INTO asins(id,asin,country,site,brand,variant_group_id) VALUES('A1 ','OTHER','US','12','Fixture','g1')",
        ),
      ).rejects.toMatchObject({ code: '23505' });
      expect((await detail(8)).json().data.asinType).toBe('MAIN_LINK');
    });
    async function blockedBy(connection: PoolClient, locktype: string) {
      await vi.waitFor(
        async () => {
          const result = await connection.query(
            'SELECT count(*)::int AS count FROM pg_locks WHERE locktype=$1 AND NOT granted AND pg_backend_pid()=ANY(pg_blocking_pids(pid))',
            [locktype],
          );
          expect(result.rows[0].count).toBeGreaterThan(0);
        },
        { timeout: 1000, interval: 20 },
      );
    }
    it('rechecks committed permission revocation after waiting on the shared RBAC lock', async () => {
      expect((await get()).statusCode).toBe(200);
      const connection = await f.pools.primaryPool.connect();
      let pending: PromiseLike<{ statusCode: number }> | undefined;
      try {
        await connection.query('BEGIN');
        await connection.query(
          'SELECT pg_advisory_xact_lock(1095977294,1380073795)',
        );
        await connection.query('DELETE FROM user_roles WHERE user_id=$1', [
          userId,
        ]);
        pending = get().then((value) => value);
        await blockedBy(connection, 'advisory');
        await connection.query('COMMIT');
        expect((await pending).statusCode).toBe(403);
      } finally {
        await connection.query('ROLLBACK');
        connection.release();
        await pending;
      }
    });
    it('bounds blocked SQL, hides driver context and restores admission after timeout', async () => {
      await seed();
      const connection = await f.pools.primaryPool.connect();
      try {
        await connection.query('BEGIN');
        await connection.query(
          'LOCK TABLE monitor_history IN ACCESS EXCLUSIVE MODE',
        );
        const started = Date.now(),
          response = await get();
        expect(response.statusCode).toBe(500);
        expect(Date.now() - started).toBeLessThan(4000);
        expect(response.body).not.toContain('monitor_history');
        expect(response.json().data).toBeUndefined();
      } finally {
        await connection.query('ROLLBACK');
        connection.release();
      }
      expect((await get()).statusCode).toBe(200);
    });
    it('returns page and count from the same MVCC statement around a concurrent insert', async () => {
      const connection = await f.pools.primaryPool.connect();
      let pending: ReturnType<typeof get> | undefined;
      try {
        await connection.query('BEGIN');
        await connection.query(
          'LOCK TABLE monitor_history IN ACCESS EXCLUSIVE MODE',
        );
        await connection.query(
          "INSERT INTO monitor_history(country,check_time) VALUES('US','2026-09-13 08:00:00')",
        );
        pending = get();
        const result = Promise.resolve(pending);
        await blockedBy(connection, 'relation');
        await connection.query('COMMIT');
        const response = await result;
        expect(response.statusCode).toBe(200);
        expect(response.json().data.list.length).toBe(
          response.json().data.total,
        );
      } finally {
        await connection.query('ROLLBACK');
        connection.release();
        await pending;
      }
    });
    it('preserves a large complete JSON result and refuses an oversized page without truncation', async () => {
      const content = '完整结果"\\'.repeat(150_000);
      await f.pools.primaryPool.query(
        "INSERT INTO monitor_history(id,country,check_time,check_result) OVERRIDING SYSTEM VALUE VALUES(107,'US','2026-09-13 08:00:00',$1::jsonb)",
        [JSON.stringify({ content })],
      );
      const response = await detail(107);
      expect(response.statusCode).toBe(200);
      const data = response.json().data;
      expect(data.check_result).toBe(data.checkResult);
      expect(JSON.parse(data.checkResult).content === content).toBe(true);
      // JSONB is copied only inside the private fixture; the response preflight
      // must avoid constructing/sending the complete oversized page.
      await f.pools.primaryPool.query(
        "INSERT INTO monitor_history(country,check_time,check_result) SELECT 'US','2026-09-13 09:00:00',check_result FROM monitor_history CROSS JOIN generate_series(1,30)",
      );
      const oversized = await get({ pageSize: '100' });
      expect(oversized.statusCode).toBe(413);
      expect(oversized.json().data).toBeUndefined();
      expect(oversized.body.length).toBeLessThan(1000);
      expect((await get({ pageSize: '1' })).statusCode).toBe(200);
    });
    it('matches MySQL per-character LIKE for accents, escapes, spaces and expansion boundaries', async () => {
      const cases = [
        ['', '%'],
        ['', '_'],
        ['Café', '%cafe%'],
        ['Straße', '%strasse%'],
        ['Straße', '%stra_e%'],
        ['a%b', '%a\\%b%'],
        ['a_b', '%a\\_b%'],
        ['a\\b', '%a\\\\b%'],
        ['abc\\', '%\\'],
        ['abc ', 'abc'],
        ['abc ', 'abc_'],
        ['aabb', '%a%b'],
        ['aba', '%ab%a'],
        ['删除快照😀', '删除_照_'],
        ['Æ', 'æ'],
        ['Æ', 'AE'],
        ['ö', 'o'],
        ['x', '%x%x'],
      ];
      for (const [value, pattern] of cases) {
        const mysqlRows = (await legacy.query(
          'SELECT ? COLLATE utf8mb4_unicode_ci LIKE ? AS matches',
          [value, pattern],
        )) as { matches: number }[];
        const pgRows = await f.pools.primaryPool.query(
          'SELECT public.neo_monitor_like($1,$2) AS matches',
          [value, pattern],
        );
        expect({ value, pattern, matches: pgRows.rows[0].matches }).toEqual({
          value,
          pattern,
          matches: Boolean(mysqlRows[0].matches),
        });
      }
    });
    it('verifies idempotent matching upgrade and transactional rollback without touching fixture rows', async () => {
      const migration = readFileSync(
        resolve(
          __dirname,
          '../../../packages/db/migrations/0007_monitor_history_matching.sql',
        ),
        'utf8',
      );
      const rollback = readFileSync(
        resolve(
          __dirname,
          '../../../packages/db/migrations/0007_monitor_history_matching.rollback.sql',
        ),
        'utf8',
      );
      // Scope tests own this CI step; public contains only the function, not data.
      await f.pools.primaryPool.query(migration);
      await f.pools.primaryPool.query(migration);
      try {
        await f.pools.primaryPool.query(rollback);
        const missing = await f.pools.primaryPool.query(
          "SELECT to_regprocedure('public.neo_monitor_like(text,text)') AS value",
        );
        expect(missing.rows[0].value).toBeNull();
      } finally {
        await f.pools.primaryPool.query(migration);
      }
      expect((await get()).statusCode).toBe(200);
    });
  },
);
