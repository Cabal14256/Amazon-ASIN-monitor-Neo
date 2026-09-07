import {
  variantGroupListResultSchema,
  variantGroupResultSchema,
} from '@asin-monitor/contracts';
import type { AsinQueryRepositoryPort } from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
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
import { ASIN_QUERY_REPOSITORY } from '../src/asin/asin-query.service';
import { AsinModule } from '../src/asin/asin.module';
import { spApiConfigApp } from './helpers/sp-api-config-app';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'ASIN queries / real PostgreSQL and Redis',
  () => {
    let f: Awaited<ReturnType<typeof spApiConfigApp>>,
      operatorId: string,
      sessionId: string,
      headers: { authorization: string };
    beforeAll(async () => {
      f = await spApiConfigApp({ imports: [AsinModule] });
      for (const table of ['variant_groups', 'asins']) {
        // Search path is already restricted and verified by the fixture helper.
        await f.pools.primaryPool.query(
          `CREATE TABLE "${table}" (LIKE public."${table}" INCLUDING ALL)`,
        );
      }
      await f.pools.primaryPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT 'reader-71',id FROM permissions WHERE code='asin:read'",
      );
    });
    afterAll(async () => {
      try {
        if (f) await f.close();
      } finally {
        vi.restoreAllMocks();
      }
    });
    beforeEach(async () => {
      await f.pools.primaryPool.query('DELETE FROM asins');
      await f.pools.primaryPool.query('DELETE FROM variant_groups');
      operatorId = randomUUID();
      sessionId = randomUUID();
      f.userIds.add(operatorId);
      await f.pools.primaryPool.query(
        'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$2,$3,false)',
        [operatorId, `u83-${operatorId}`, 'fixture-unused-hash'],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO user_roles(user_id,role_id) VALUES($1,'reader-71')",
        [operatorId],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,'2099-01-01 08:00:00')",
        [sessionId, operatorId],
      );
      headers = {
        authorization: `Bearer ${jwt.sign(
          { userId: operatorId, sessionId },
          f.env.JWT_SECRET,
          { expiresIn: '1h' },
        )}`,
      };
    });
    const get = (suffix = '', auth = headers) =>
      f.http.inject({
        method: 'GET',
        url: `/api/v1/variant-groups${suffix}`,
        headers: auth,
      });
    async function group(
      id: string,
      name = id,
      country = 'US',
      manual = false,
    ) {
      await f.pools.primaryPool.query(
        "INSERT INTO variant_groups(id,name,country,site,brand,manual_broken,manual_broken_reason,create_time,update_time) VALUES($1,$2,$3,'amazon.com','Fixture',$4,$5,'2026-09-07 08:00:00','2026-09-07 09:00:00')",
        [id, name, country, manual, manual ? 'Group fixture reason' : null],
      );
    }
    async function asin(
      id: string,
      parent: string,
      options: {
        country?: string;
        broken?: boolean;
        manual?: boolean;
        excluded?: boolean;
        code?: string;
      } = {},
    ) {
      await f.pools.primaryPool.query(
        "INSERT INTO asins(id,asin,name,country,site,brand,variant_group_id,is_broken,manual_broken,manual_excluded_from_group,create_time,update_time) VALUES($1,$2,'Fixture product',$3,'amazon.com','Fixture',$4,$5,$6,$7,'2026-09-07 08:00:00','2026-09-07 09:00:00')",
        [
          id,
          options.code ?? `B${id.padStart(9, '0')}`,
          options.country ?? 'US',
          parent,
          options.broken ?? false,
          options.manual ?? false,
          options.excluded ?? false,
        ],
      );
    }
    async function blockedBy(connection: PoolClient, locktype = 'advisory') {
      await vi.waitFor(
        async () => {
          const rows = await connection.query(
            'SELECT count(*)::int AS count FROM pg_locks WHERE locktype=$1 AND NOT granted AND pg_backend_pid()=ANY(pg_blocking_pids(pid))',
            [locktype],
          );
          expect(rows.rows[0].count).toBeGreaterThan(0);
        },
        { timeout: 1000, interval: 20 },
      );
    }
    it('serves both real contracts with D8 timestamps and nullable historical dates', async () => {
      await group('g1');
      await asin('1', 'g1');
      const list = await get();
      expect(list.statusCode).toBe(200);
      variantGroupListResultSchema.parse(list.json());
      expect(list.json().data).toMatchObject({
        total: 1,
        totalASINs: 1,
        current: 1,
        pageSize: 10,
      });
      expect(list.json().data.list[0]).toMatchObject({
        createTime: '2026-09-07T00:00:00.000Z',
        update_time: '2026-09-07T01:00:00.000Z',
        children: [{ createTime: '2026-09-07T00:00:00.000Z' }],
      });
      expect(list.headers['cache-control']).toBe('no-store');
      await f.pools.primaryPool.query(
        'UPDATE variant_groups SET create_time=NULL,update_time=NULL',
      );
      await f.pools.primaryPool.query(
        'UPDATE asins SET create_time=NULL,update_time=NULL',
      );
      const detail = await get('/g1');
      expect(detail.statusCode).toBe(200);
      variantGroupResultSchema.parse(detail.json());
      expect(detail.json().data).toMatchObject({
        createTime: null,
        update_time: null,
        children: [{ createTime: null }],
      });
      expect((await get('', {} as never)).statusCode).toBe(401);
      expect((await get('/missing')).statusCode).toBe(404);
    });
    it('counts keyword-matching empty groups and keeps page order stable', async () => {
      await group('g1', 'Needle empty');
      await group('g2', 'Needle full');
      await group('g3', 'Other');
      await asin('1', 'g2');
      const first = (await get('?keyword=Needle&pageSize=1')).json().data;
      const second = (await get('?keyword=Needle&pageSize=1&current=2')).json()
        .data;
      expect(first).toMatchObject({
        total: 2,
        totalASINs: 1,
        list: [{ id: 'g2' }],
      });
      expect(second).toMatchObject({
        total: 2,
        totalASINs: 1,
        list: [{ id: 'g1', asin_count: 0, children: [] }],
      });
    });
    it('retains full children and their effective status while keyword counts only matching children', async () => {
      await group('g1');
      await asin('1', 'g1', { code: 'B000000001' });
      await asin('2', 'g1', { code: 'B000000002', manual: true });
      const response = await get('?keyword=B000000001&variantStatus=BROKEN');
      expect(response.statusCode).toBe(200);
      const result = response.json().data;
      expect(result).toMatchObject({
        total: 1,
        totalASINs: 0,
        list: [
          {
            asin_count: 1,
            isBroken: 1,
            manualBroken: 0,
            statusSource: 'MANUAL',
          },
        ],
      });
      expect(result.list[0].children).toHaveLength(2);
    });
    it('keeps child-country totals independent of group-country filtering', async () => {
      await group('g1', 'Cross-country', 'US');
      await asin('1', 'g1', { country: 'UK' });
      expect((await get('?country=us')).json().data).toMatchObject({
        total: 1,
        totalASINs: 0,
        list: [{ children: [{ country: 'UK' }] }],
      });
      expect((await get('?country=UK')).json().data).toMatchObject({
        total: 0,
        totalASINs: 1,
        list: [],
      });
    });
    it('matches automatic/manual/group exclusion SQL filters with decorated states', async () => {
      await group('g1', 'Manual group', 'US', true);
      await asin('1', 'g1');
      await asin('2', 'g1', { excluded: true });
      await asin('3', 'g1', { broken: true, excluded: true });
      const broken = (await get('?variantStatus=BROKEN')).json().data;
      expect(broken.totalASINs).toBe(2);
      expect(
        broken.list[0].children.map(
          (row: { isBroken: number; manualBrokenScope: string }) => [
            row.isBroken,
            row.manualBrokenScope,
          ],
        ),
      ).toEqual([
        [1, 'GROUP'],
        [0, 'GROUP_EXCLUDED'],
        [1, 'GROUP_EXCLUDED'],
      ]);
      expect((await get('?variantStatus=NORMAL')).json().data).toMatchObject({
        total: 0,
        totalASINs: 1,
        list: [],
      });
    });
    it('binds hostile strings as values and retains intentional keyword wildcards', async () => {
      await group('g1', 'Needle');
      expect(
        (await get('?keyword=' + encodeURIComponent("' OR 1=1--"))).json().data
          .total,
      ).toBe(0);
      expect(
        (await get('/' + encodeURIComponent("' OR 1=1--"))).statusCode,
      ).toBe(404);
      expect((await get('?country=US%25')).json().data.total).toBe(0);
      expect((await get('?keyword=N_ed%25')).json().data.total).toBe(1);
    });
    it('honors committed revocation after a shared reader waits behind the real RBAC writer lock', async () => {
      expect((await get()).statusCode).toBe(200); // Prime actual Redis permission cache.
      const connection = await f.pools.primaryPool.connect();
      let pending: PromiseLike<{ statusCode: number }> | undefined;
      try {
        await connection.query('BEGIN');
        await connection.query(
          'SELECT pg_advisory_xact_lock(1095977294,1380073795)',
        );
        await connection.query('DELETE FROM user_roles WHERE user_id=$1', [
          operatorId,
        ]);
        pending = get().then((response) => response);
        await blockedBy(connection);
        await connection.query('COMMIT');
        expect((await pending).statusCode).toBe(403);
      } finally {
        try {
          await connection.query('ROLLBACK');
        } finally {
          connection.release();
          await pending;
        }
      }
    });
    it('allows two same-session readers to hold shared locks while an administrator waits', async () => {
      const repository = f.app.get<AsinQueryRepositoryPort>(
        ASIN_QUERY_REPOSITORY,
      );
      let release!: () => void,
        ready = 0;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const readers = Array.from({ length: 2 }, () =>
        repository.read(async (unit) => {
          await unit.lockOperator(operatorId);
          await unit.lockSession(operatorId, sessionId);
          expect(await unit.operatorPermissionCodes(operatorId)).toContain(
            'asin:read',
          );
          ready++;
          await gate;
          return unit.list({ current: 1, pageSize: 10 });
        }),
      );
      const writer = await f.pools.primaryPool.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await vi.waitFor(() => expect(ready).toBe(2), { timeout: 1000 });
        await writer.query('BEGIN');
        pending = writer.query(
          'SELECT pg_advisory_xact_lock(1095977294,1380073795)',
        );
        await vi.waitFor(
          async () => {
            // Query from a separate connection: the writer itself is waiting.
            const result = await f.pools.primaryPool.query(
              "SELECT count(*)::int AS count FROM pg_locks WHERE locktype='advisory' AND classid=1095977294::oid AND objid=1380073795::oid AND mode='ExclusiveLock' AND NOT granted",
            );
            expect(result.rows[0].count).toBeGreaterThan(0);
          },
          { timeout: 1000, interval: 20 },
        );
      } finally {
        release();
        await Promise.allSettled(readers);
        await pending;
        await writer.query('ROLLBACK');
        writer.release();
      }
      await expect(Promise.all(readers)).resolves.toHaveLength(2);
    });
    it('returns counts, rows and children from one snapshot around a concurrent data commit', async () => {
      await group('g1');
      await asin('1', 'g1');
      const connection = await f.pools.primaryPool.connect();
      let pending:
        | PromiseLike<{
            statusCode: number;
            json(): {
              data: {
                total: number;
                totalASINs: number;
                list: { children: unknown[] }[];
              };
            };
          }>
        | undefined;
      try {
        await connection.query('BEGIN');
        await connection.query(
          'LOCK TABLE variant_groups,asins IN ACCESS EXCLUSIVE MODE',
        );
        await connection.query(
          "INSERT INTO variant_groups(id,name,country,site,brand) VALUES('g2','Second','US','amazon.com','Fixture')",
        );
        await connection.query(
          "INSERT INTO asins(id,asin,country,site,brand,variant_group_id) VALUES('2','B000000002','US','amazon.com','Fixture','g2')",
        );
        pending = get().then((response) => response);
        await blockedBy(connection, 'relation');
        await connection.query('COMMIT');
        const response = await pending;
        expect(response.statusCode).toBe(200);
        const value = response.json().data;
        expect([1, 2]).toContain(value.total);
        expect(value.total).toBe(value.list.length);
        expect(value.totalASINs).toBe(
          value.list.reduce((count, row) => count + row.children.length, 0),
        );
        expect(value.totalASINs).toBe(value.total);
      } finally {
        try {
          await connection.query('ROLLBACK');
        } finally {
          connection.release();
          await pending;
        }
      }
    });
    it('refuses 5001 children without returning partial groups on either endpoint', async () => {
      await group('g1');
      await f.pools.primaryPool.query(
        "INSERT INTO asins(id,asin,country,site,brand,variant_group_id) SELECT 'cap-'||n, 'B'||lpad(n::text,9,'0'),'US','amazon.com','Fixture','g1' FROM generate_series(1,5001) n",
      );
      for (const path of ['', '/g1']) {
        const response = await get(path);
        expect(response.statusCode).toBe(413);
        expect(response.json().data).toBeUndefined();
      }
    });
    it('bounds real SQL lock waits and recovers after the blocking transaction ends', async () => {
      await group('g1');
      const connection = await f.pools.primaryPool.connect();
      try {
        await connection.query('BEGIN');
        await connection.query(
          'LOCK TABLE variant_groups IN ACCESS EXCLUSIVE MODE',
        );
        const response = await get();
        expect(response.statusCode).toBe(500);
        expect(response.json().errorMessage).toBe('服务器内部错误');
        expect(response.body).not.toContain('statement_timeout');
      } finally {
        try {
          await connection.query('ROLLBACK');
        } finally {
          connection.release();
        }
      }
      expect((await get()).statusCode).toBe(200);
    });
  },
);
