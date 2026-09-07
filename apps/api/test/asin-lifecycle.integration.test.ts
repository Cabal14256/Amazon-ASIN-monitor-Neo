import {
  asinRecordResultSchema,
  variantGroupResultSchema,
} from '@asin-monitor/contracts';
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
import { asinWriteApp } from './helpers/asin-write-app';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'ASIN deletion and notification / real PostgreSQL and Redis',
  () => {
    let f: Awaited<ReturnType<typeof asinWriteApp>>;
    let headers: { authorization: string; origin: string };
    beforeAll(async () => {
      f = await asinWriteApp();
      await f.pools.primaryPool.query(
        'CREATE TABLE monitor_history (LIKE public.monitor_history INCLUDING ALL)',
      );
      await f.pools.primaryPool.query(
        'CREATE TABLE fail_deletes_fixture(id varchar(50) PRIMARY KEY)',
      );
      await f.pools.primaryPool
        .query(`CREATE FUNCTION fail_asin_delete_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF EXISTS(SELECT 1 FROM fail_deletes_fixture WHERE id=OLD.id) THEN RAISE EXCEPTION 'fixture child deletion failure'; END IF; RETURN OLD; END $$`);
      await f.pools.primaryPool.query(
        'CREATE TRIGGER fail_asin_delete_fixture AFTER DELETE ON asins FOR EACH ROW EXECUTE FUNCTION fail_asin_delete_fixture()',
      );
      await f.pools.primaryPool.query(
        "INSERT INTO roles(id,code,name) VALUES('deleter-89','CUSTOM','Deletion only fixture')",
      );
      await f.pools.primaryPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT 'deleter-89',id FROM permissions WHERE code='asin:delete'",
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
      await f.pools.primaryPool.query(
        'TRUNCATE fail_deletes_fixture, monitor_history',
      );
      await f.pools.primaryPool.query('DELETE FROM asins');
      await f.pools.primaryPool.query('DELETE FROM variant_groups');
      await f.pools.primaryPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT 'deleter-89',id FROM permissions WHERE code='asin:delete' ON CONFLICT DO NOTHING",
      );
      await login('deleter-89');
    });
    async function login(role: 'deleter-89' | 'writer-71') {
      const userId = randomUUID(),
        sessionId = randomUUID();
      f.userIds.add(userId);
      await f.pools.primaryPool.query(
        'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$2,$3,false)',
        [userId, `u89-${userId}`, 'fixture-unused-hash'],
      );
      await f.pools.primaryPool.query(
        'INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)',
        [userId, role],
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
        origin: f.env.CORS_ORIGIN,
      };
    }
    const request = (
      method: 'DELETE' | 'PUT' | 'POST',
      path: string,
      payload?: Record<string, unknown>,
      auth = headers,
    ) =>
      f.http.inject({
        method,
        url: `/api/v1${path}`,
        headers: auth,
        ...(payload ? { payload } : {}),
      });
    async function group(id: string, manual = false) {
      await f.pools.primaryPool.query(
        "INSERT INTO variant_groups(id,name,country,site,brand,manual_broken,manual_broken_reason,feishu_notify_enabled,create_time,update_time) VALUES($1,$1,'US','amazon.com','Fixture',$2,$3,NULL,'2020-01-01 08:00:00','2020-01-01 08:00:00')",
        [id, manual, manual ? 'parent reason' : null],
      );
    }
    async function asin(id: string, parent: string) {
      await f.pools.primaryPool.query(
        "INSERT INTO asins(id,asin,name,country,site,brand,variant_group_id,feishu_notify_enabled,create_time,update_time) VALUES($1,$1,'Product','US','amazon.com','Fixture',$2,NULL,'2020-01-01 08:00:00','2020-01-01 08:00:00')",
        [id, parent],
      );
    }
    async function history(parent: string, child: string) {
      await f.pools.primaryPool.query(
        "INSERT INTO monitor_history(variant_group_id,variant_group_name,asin_id,asin_code,country,check_time,check_result) VALUES($1,'Historical group',$2,'Historical ASIN','US','2026-09-07 08:00:00','{\"historical\":true}')",
        [parent, child],
      );
    }
    const rows = async (
      table: 'asins' | 'variant_groups' | 'monitor_history',
    ) =>
      (
        await f.pools.primaryPool.query(
          `SELECT row_to_json(t) AS data FROM ${table} t ORDER BY id`,
        )
      ).rows.map((row) => row.data);
    async function blockedBy(client: PoolClient, kind = 'transactionid') {
      await vi.waitFor(
        async () => {
          expect(
            (
              await client.query(
                'SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype=$1 AND pg_backend_pid()=ANY(pg_blocking_pids(pid))',
                [kind],
              )
            ).rows[0].n,
          ).toBeGreaterThan(0);
        },
        { timeout: 1000, interval: 10 },
      );
    }
    async function twoParentWaiters(client: PoolClient) {
      await vi.waitFor(
        async () => {
          const result = await client.query(
            "SELECT count(DISTINCT pid)::int AS n FROM pg_locks WHERE NOT granted AND locktype IN ('tuple','transactionid') AND array_length(pg_blocking_pids(pid),1)>0 AND pid IN (SELECT pid FROM pg_locks WHERE relation=to_regclass('variant_groups') AND granted AND mode='RowShareLock')",
          );
          expect(result.rows[0].n).toBeGreaterThanOrEqual(2);
        },
        { timeout: 1000, interval: 10 },
      );
    }
    it('deletes a group with cascading children, preserves history and unrelated groups, and repeats successfully', async () => {
      await group('g1');
      await group('g2');
      await asin('a1', 'g1');
      await asin('a2', 'g2');
      await history('g1', 'a1');
      const oldHistory = await rows('monitor_history');
      for (let i = 0; i < 2; i++) {
        const response = await request('DELETE', '/variant-groups/g1');
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({
          success: true,
          errorCode: 0,
          data: '删除成功',
        });
        expect(response.headers['cache-control']).toBe('no-store');
      }
      expect((await rows('variant_groups')).map((row) => row.id)).toEqual([
        'g2',
      ]);
      expect((await rows('asins')).map((row) => row.id)).toEqual(['a2']);
      expect(await rows('monitor_history')).toEqual(oldHistory);
    });
    it('deletes an ASIN and touches its parent atomically, preserves history and repeats without touching again', async () => {
      await group('g');
      await asin('a', 'g');
      await history('g', 'a');
      const oldHistory = await rows('monitor_history');
      expect((await request('DELETE', '/asins/a')).statusCode).toBe(200);
      const after = await rows('variant_groups');
      expect(after[0].update_time).not.toBe('2020-01-01T08:00:00');
      expect(await rows('asins')).toEqual([]);
      expect((await request('DELETE', '/asins/a')).statusCode).toBe(200);
      expect(await rows('variant_groups')).toEqual(after);
      expect(await rows('monitor_history')).toEqual(oldHistory);
    });
    it('rolls back ASIN deletion when its parent timestamp update fails', async () => {
      await group('g-fail-touch');
      await asin('a', 'g-fail-touch');
      await history('g-fail-touch', 'a');
      const before = await Promise.all([
        rows('asins'),
        rows('variant_groups'),
        rows('monitor_history'),
      ]);
      const result = await request('DELETE', '/asins/a');
      expect(result.statusCode).toBe(500);
      expect(result.body).not.toContain('fixture parent touch failure');
      expect(
        await Promise.all([
          rows('asins'),
          rows('variant_groups'),
          rows('monitor_history'),
        ]),
      ).toEqual(before);
    });
    it('rolls back the group and every cascaded child if a child deletion fails', async () => {
      await group('g');
      await asin('a', 'g');
      await asin('b', 'g');
      await history('g', 'a');
      await f.pools.primaryPool.query(
        "INSERT INTO fail_deletes_fixture VALUES('b')",
      );
      const before = await Promise.all([
        rows('asins'),
        rows('variant_groups'),
        rows('monitor_history'),
      ]);
      expect((await request('DELETE', '/variant-groups/g')).statusCode).toBe(
        500,
      );
      expect(
        await Promise.all([
          rows('asins'),
          rows('variant_groups'),
          rows('monitor_history'),
        ]),
      ).toEqual(before);
    });
    it.each([false, true])(
      'changes only the group notification setting/time, with enabled=%s',
      async (enabled) => {
        await login('writer-71');
        await group('g', true);
        await asin('a', 'g');
        const children = await rows('asins'),
          before = (await rows('variant_groups'))[0];
        const response = await request(
          'PUT',
          '/variant-groups/g/feishu-notify',
          { enabled },
        );
        expect(response.statusCode).toBe(200);
        expect(
          variantGroupResultSchema.parse(response.json()).data,
        ).toMatchObject({
          id: 'g',
          feishuNotifyEnabled: Number(enabled),
          children: [{ id: 'a', feishuNotifyEnabled: 1, manualBroken: 1 }],
        });
        const after = (await rows('variant_groups'))[0];
        expect(after.feishu_notify_enabled).toBe(enabled);
        expect({
          ...after,
          feishu_notify_enabled: before.feishu_notify_enabled,
          update_time: before.update_time,
        }).toEqual(before);
        expect(after.update_time).not.toBe(before.update_time);
        expect(await rows('asins')).toEqual(children);
      },
    );
    it.each([0, 1])(
      'changes only the ASIN notification setting/time, with enabled=%s',
      async (enabled) => {
        await login('writer-71');
        await group('g', true);
        await asin('a', 'g');
        const parents = await rows('variant_groups'),
          before = (await rows('asins'))[0];
        const response = await request('PUT', '/asins/a/feishu-notify', {
          enabled,
        });
        expect(response.statusCode).toBe(200);
        expect(
          asinRecordResultSchema.parse(response.json()).data,
        ).toMatchObject({
          id: 'a',
          feishuNotifyEnabled: enabled,
          parentId: 'g',
          manualBroken: 1,
          statusSource: 'MANUAL',
        });
        const after = (await rows('asins'))[0];
        expect(after.feishu_notify_enabled).toBe(Boolean(enabled));
        expect({
          ...after,
          feishu_notify_enabled: before.feishu_notify_enabled,
          update_time: before.update_time,
        }).toEqual(before);
        expect(after.update_time).not.toBe(before.update_time);
        expect(await rows('variant_groups')).toEqual(parents);
      },
    );
    it.each([
      '/variant-groups/missing/feishu-notify',
      '/asins/missing/feishu-notify',
    ])('returns 404 for the missing notification target %s', async (path) => {
      await login('writer-71');
      expect((await request('PUT', path, { enabled: false })).statusCode).toBe(
        404,
      );
    });
    it('rolls back an oversized group notification response', async () => {
      await login('writer-71');
      await group('g');
      await f.pools.primaryPool.query(
        "INSERT INTO asins(id,asin,country,site,brand,variant_group_id) SELECT 'a'||n,'B'||n,'US','amazon.com','Fixture','g' FROM generate_series(1,5001) n",
      );
      const before = await rows('variant_groups');
      expect(
        (
          await request('PUT', '/variant-groups/g/feishu-notify', {
            enabled: false,
          })
        ).statusCode,
      ).toBe(413);
      expect(await rows('variant_groups')).toEqual(before);
    });
    it('keeps concurrent repeated ASIN deletion idempotent', async () => {
      await group('g');
      await asin('a', 'g');
      const responses = await Promise.all([
        request('DELETE', '/asins/a'),
        request('DELETE', '/asins/a'),
      ]);
      expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
      expect(await rows('asins')).toEqual([]);
      expect((await rows('variant_groups'))[0].update_time).not.toBe(
        '2020-01-01T08:00:00',
      );
    });
    it('keeps ASIN deletion idempotent when a waiting group deletion cascades first', async () => {
      await group('g');
      await asin('a', 'g');
      await history('g', 'a');
      const oldHistory = await rows('monitor_history'),
        blocker = await f.pools.primaryPool.connect();
      const pending: Promise<unknown>[] = [];
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          "SELECT id FROM variant_groups WHERE id='g' FOR UPDATE",
        );
        const groupDelete = Promise.resolve(
          request('DELETE', '/variant-groups/g'),
        );
        pending.push(groupDelete.catch(() => {}));
        await blockedBy(blocker);
        const childDelete = Promise.resolve(request('DELETE', '/asins/a'));
        pending.push(childDelete.catch(() => {}));
        await twoParentWaiters(blocker);
        await blocker.query('COMMIT');
        expect((await groupDelete).statusCode).toBe(200);
        expect((await childDelete).statusCode).toBe(200);
        expect(await rows('asins')).toEqual([]);
        expect(await rows('variant_groups')).toEqual([]);
        expect(await rows('monitor_history')).toEqual(oldHistory);
      } finally {
        await blocker.query('ROLLBACK');
        await Promise.all(pending);
        blocker.release();
      }
    });
    it('refuses to delete an ASIN that moved while its candidate parent lock was waiting', async () => {
      await group('a-source');
      await group('b-target');
      await asin('a', 'a-source');
      const deletionHeaders = { ...headers };
      await login('writer-71');
      const blocker = await f.pools.primaryPool.connect();
      const pending: Promise<unknown>[] = [];
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          "SELECT id FROM variant_groups WHERE id='a-source' FOR UPDATE",
        );
        const move = Promise.resolve(
          request('POST', '/asins/a/move', { targetGroupId: 'b-target' }),
        );
        pending.push(move.catch(() => {}));
        await blockedBy(blocker);
        const deletion = Promise.resolve(
          request('DELETE', '/asins/a', undefined, deletionHeaders),
        );
        pending.push(deletion.catch(() => {}));
        await twoParentWaiters(blocker);
        await blocker.query('COMMIT');
        expect((await move).statusCode).toBe(200);
        expect((await deletion).statusCode).toBe(409);
        expect((await rows('asins'))[0].variant_group_id).toBe('b-target');
      } finally {
        await blocker.query('ROLLBACK');
        await Promise.all(pending);
        blocker.release();
      }
    });
    it('rechecks a cached deletion permission after a blocking administration revokes it', async () => {
      await group('g');
      await asin('a', 'g');
      expect((await request('DELETE', '/asins/missing')).statusCode).toBe(200);
      const blocker = await f.pools.primaryPool.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'SELECT pg_advisory_xact_lock(1095977294,1380073795)',
        );
        await blocker.query(
          "DELETE FROM role_permissions rp USING permissions p WHERE rp.permission_id=p.id AND rp.role_id='deleter-89' AND p.code='asin:delete'",
        );
        const deletion = Promise.resolve(request('DELETE', '/asins/a'));
        pending = deletion.catch(() => {});
        await blockedBy(blocker, 'advisory');
        await blocker.query('COMMIT');
        expect((await deletion).statusCode).toBe(403);
        expect((await rows('asins')).map((row) => row.id)).toEqual(['a']);
        expect((await rows('variant_groups'))[0].update_time).toBe(
          '2020-01-01T08:00:00',
        );
      } finally {
        await blocker.query('ROLLBACK');
        await pending;
        blocker.release();
      }
    });
  },
);
