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
  'ASIN manual actions and atomic history / PostgreSQL and Redis',
  () => {
    let f: Awaited<ReturnType<typeof asinWriteApp>>;
    let headers: { authorization: string; origin: string }, userId: string;
    beforeAll(async () => {
      f = await asinWriteApp();
      await f.pools.primaryPool.query(
        'CREATE TABLE monitor_history (LIKE public.monitor_history INCLUDING ALL)',
      );
      await f.pools.primaryPool.query(
        'CREATE SEQUENCE manual_history_attempt_fixture',
      );
      await f.pools.primaryPool.query(
        'CREATE TABLE manual_history_failure_fixture(after_count integer NOT NULL)',
      );
      await f.pools.primaryPool
        .query(`CREATE FUNCTION manual_history_failure_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      DECLARE attempt bigint; fail_after integer;
      BEGIN attempt := nextval('manual_history_attempt_fixture'); SELECT after_count INTO fail_after FROM manual_history_failure_fixture;
      IF fail_after IS NOT NULL AND attempt > fail_after THEN RAISE EXCEPTION 'fixture private history failure'; END IF; RETURN NEW; END $$`);
      await f.pools.primaryPool.query(
        'CREATE TRIGGER manual_history_failure_fixture BEFORE INSERT ON monitor_history FOR EACH ROW EXECUTE FUNCTION manual_history_failure_fixture()',
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
        'TRUNCATE monitor_history, manual_history_failure_fixture',
      );
      await f.pools.primaryPool.query(
        'ALTER SEQUENCE manual_history_attempt_fixture RESTART WITH 1',
      );
      await f.pools.primaryPool.query('DELETE FROM asins');
      await f.pools.primaryPool.query('DELETE FROM variant_groups');
      await f.pools.primaryPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT 'writer-71',id FROM permissions WHERE code='asin:write' ON CONFLICT DO NOTHING",
      );
      await login();
    });
    async function login() {
      userId = randomUUID();
      const sessionId = randomUUID();
      f.userIds.add(userId);
      await f.pools.primaryPool.query(
        'INSERT INTO users(id,username,real_name,password,force_password_change) VALUES($1,$2,$3,$4,false)',
        [userId, `u91-${userId}`, 'Fixture actor', 'unused-fixture-hash'],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO user_roles(user_id,role_id) VALUES($1,'writer-71')",
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
        origin: f.env.CORS_ORIGIN,
      };
    }
    const write = (
      path: string,
      payload: Record<string, unknown>,
      auth = headers,
    ) =>
      f.http.inject({
        method: 'PUT',
        url: `/api/v1${path}/manual-broken`,
        headers: auth,
        payload,
      });
    async function seed(parent = 'g', childCount = 1, manual = true) {
      await f.pools.primaryPool.query(
        "INSERT INTO variant_groups(id,name,country,site,brand,manual_broken,manual_broken_reason,manual_broken_updated_at,manual_broken_updated_by,create_time,update_time) VALUES($1,'Group snapshot','US','amazon.com','Fixture',$2,'Parent reason','2020-01-01 08:00:00','Old parent actor','2020-01-01 08:00:00','2020-01-01 08:00:00')",
        [parent, manual],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO asins(id,asin,name,country,site,brand,variant_group_id,create_time,update_time) SELECT 'a'||n,'B'||n,'Product '||n,'us','Child site','Child brand',$1,'2020-01-01 08:00:00','2020-01-01 08:00:00' FROM generate_series(1,$2::integer) n",
        [parent, childCount],
      );
    }
    const rows = async (
      table: 'variant_groups' | 'asins' | 'monitor_history',
    ) =>
      (
        await f.pools.primaryPool.query(
          `SELECT row_to_json(t) AS data FROM ${table} t ORDER BY id`,
        )
      ).rows.map((row) => row.data);
    const business = async () => ({
      groups: await rows('variant_groups'),
      asins: await rows('asins'),
    });
    const mark = { markedBroken: true, reason: 'New group reason' };
    const ownMark = { action: 'MARK_BROKEN', reason: 'New own reason' };
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
    async function twoParents(client: PoolClient) {
      await vi.waitFor(
        async () => {
          expect(
            (
              await client.query(
                "SELECT count(DISTINCT pid)::int AS n FROM pg_locks WHERE NOT granted AND locktype IN ('tuple','transactionid') AND array_length(pg_blocking_pids(pid),1)>0 AND pid IN (SELECT pid FROM pg_locks WHERE relation=to_regclass('variant_groups') AND granted AND mode='RowShareLock')",
              )
            ).rows[0].n,
          ).toBeGreaterThanOrEqual(2);
        },
        { timeout: 1000, interval: 10 },
      );
    }
    it('marks an ASIN, touches its parent, and stores Shanghai history with the same operation instant and snapshots', async () => {
      await seed();
      const response = await write('/asins/a1', ownMark);
      expect(response.statusCode).toBe(200);
      asinRecordResultSchema.parse(response.json());
      const data = response.json().data;
      expect(data).toMatchObject({
        manualBrokenScope: 'SELF+GROUP',
        selfManualBrokenReason: 'New own reason',
        selfManualBrokenUpdatedBy: 'Fixture actor',
      });
      const history = await rows('monitor_history');
      expect(history).toHaveLength(1);
      expect(history[0]).toMatchObject({
        variant_group_id: 'g',
        variant_group_name: 'Group snapshot',
        asin_id: 'a1',
        asin_code: 'B1',
        asin_name: 'Product 1',
        site_snapshot: 'Child site',
        brand_snapshot: 'Child brand',
        country: 'us',
        check_type: 'ASIN',
        is_broken: true,
        notification_sent: false,
        check_result: {
          source: 'MANUAL_ACTION',
          action: 'MARK_BROKEN',
          previousStatusSource: 'MANUAL',
          manualBrokenScope: 'SELF+GROUP',
          operator: 'Fixture actor',
          manualBrokenUpdatedAt: data.selfManualBrokenUpdatedAt,
        },
      });
      expect(new Date(`${history[0].check_time}+08:00`).toISOString()).toBe(
        data.selfManualBrokenUpdatedAt,
      );
      expect(history[0].create_time).toBe(history[0].check_time);
      expect(history[0].hour_ts).toBe(
        history[0].check_time.slice(0, 13) + ':00:00',
      );
      expect((await rows('variant_groups'))[0].update_time).not.toBe(
        '2020-01-01T08:00:00',
      );
    });
    it.each([
      'CLEAR_SELF_MANUAL',
      'EXCLUDE_GROUP_MANUAL',
      'CLEAR_GROUP_EXCLUSION',
    ])(
      'preserves automatic state and the other manual family for %s',
      async (action) => {
        await seed();
        await f.pools.primaryPool.query(
          "UPDATE asins SET is_broken=true,manual_broken=true,manual_broken_reason='Own reason',manual_excluded_from_group=true,manual_excluded_reason='Old exclusion' WHERE id='a1'",
        );
        const response = await write('/asins/a1', {
          action,
          reason: action === 'EXCLUDE_GROUP_MANUAL' ? 'New exclusion' : '',
        });
        expect(response.statusCode).toBe(200);
        const data = response.json().data;
        expect(data.autoIsBroken).toBe(1);
        expect(data.selfManualBroken).toBe(
          action === 'CLEAR_SELF_MANUAL' ? 0 : 1,
        );
        expect(data.manualExcludedFromGroup).toBe(
          action === 'CLEAR_GROUP_EXCLUSION' ? 0 : 1,
        );
        expect((await rows('monitor_history'))[0].check_result).toMatchObject({
          action,
          previousEffectiveIsBroken: 1,
          effectiveIsBroken: 1,
          reason:
            action === 'EXCLUDE_GROUP_MANUAL' ? 'New exclusion' : 'Own reason',
        });
      },
    );
    it('allows exclusion before the parent has a manual marker', async () => {
      await seed('g', 1, false);
      const response = await write('/asins/a1', {
        action: 'EXCLUDE_GROUP_MANUAL',
        reason: 'Future exclusion',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject({
        isBroken: 0,
        manualBrokenScope: 'NONE',
        manualExcludedFromGroup: 1,
      });
      expect((await rows('monitor_history'))[0].is_broken).toBe(false);
    });
    it('marks a group and writes one group plus every child history without changing child records', async () => {
      await seed('g', 4, false);
      await f.pools.primaryPool.query(
        "UPDATE asins SET manual_excluded_from_group=true,manual_excluded_reason='Excluded' WHERE id='a2'",
      );
      await f.pools.primaryPool.query(
        "UPDATE asins SET manual_broken=true,manual_broken_reason='Self' WHERE id='a3'",
      );
      await f.pools.primaryPool.query(
        "UPDATE asins SET is_broken=true WHERE id='a4'",
      );
      const before = await rows('asins');
      const response = await write('/variant-groups/g', mark);
      expect(response.statusCode).toBe(200);
      variantGroupResultSchema.parse(response.json());
      expect(await rows('asins')).toEqual(before);
      const history = await rows('monitor_history');
      expect(history).toHaveLength(5);
      expect(
        history.filter((row) => row.check_type === 'GROUP')[0].check_result
          .action,
      ).toBe('MARK_BROKEN');
      expect(
        history
          .filter((row) => row.check_type === 'ASIN')
          .every(
            (row) => row.check_result.action === 'APPLY_GROUP_MANUAL_BROKEN',
          ),
      ).toBe(true);
      expect(history.find((row) => row.asin_id === 'a2')).toMatchObject({
        is_broken: false,
        check_result: { manualBrokenScope: 'GROUP_EXCLUDED' },
      });
      expect(new Set(history.map((row) => row.check_time)).size).toBe(1);
    });
    it('clears only active child exclusions, preserves own/automatic state and writes all propagation histories', async () => {
      await seed('g', 3);
      await f.pools.primaryPool.query(
        "UPDATE asins SET manual_excluded_from_group=true,manual_excluded_reason='Excluded',manual_excluded_updated_at='2020-01-01 08:00:00',manual_excluded_updated_by='Old actor',is_broken=true WHERE id='a1'",
      );
      await f.pools.primaryPool.query(
        "UPDATE asins SET manual_excluded_from_group=false,manual_excluded_reason='Historical metadata',manual_broken=true,manual_broken_reason='Self' WHERE id='a2'",
      );
      const before = await rows('asins');
      const response = await write('/variant-groups/g', {
        markedBroken: '0',
        reason: 'Ignored on clear',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject({
        manualBroken: 0,
        manualBrokenReason: null,
        isBroken: 1,
      });
      const after = await rows('asins');
      expect(after[0]).toMatchObject({
        manual_excluded_from_group: false,
        manual_excluded_reason: null,
        manual_excluded_updated_at: null,
        manual_excluded_updated_by: null,
        is_broken: true,
      });
      expect(after.slice(1)).toEqual(before.slice(1));
      const history = await rows('monitor_history');
      expect(history).toHaveLength(4);
      expect(
        history.every((row) => row.check_result.reason === 'Parent reason'),
      ).toBe(true);
      expect(history[0].check_result).toMatchObject({
        action: 'CLEAR_MANUAL_BROKEN',
        manualBroken: 0,
        manualBrokenUpdatedBy: 'Fixture actor',
      });
    });
    it('records repeated empty-group actions as distinct operations', async () => {
      await seed('g', 0);
      for (let count = 0; count < 2; count++)
        expect(
          (await write('/variant-groups/g', { markedBroken: false }))
            .statusCode,
        ).toBe(200);
      expect(
        (await rows('monitor_history')).map((row) => row.check_type),
      ).toEqual(['GROUP', 'GROUP']);
    });
    it('rolls the ASIN marker back when parent timestamp touch fails', async () => {
      await seed('g-fail-touch');
      const before = await business();
      expect((await write('/asins/a1', ownMark)).statusCode).toBe(500);
      expect(await business()).toEqual(before);
      expect(await rows('monitor_history')).toEqual([]);
    });
    it.each(['/asins/a1', '/variant-groups/g'])(
      'rolls state and timestamps back if the first history insert fails at %s',
      async (path) => {
        await seed();
        await f.pools.primaryPool.query(
          'INSERT INTO manual_history_failure_fixture VALUES(0)',
        );
        const before = await business();
        const response = await write(
          path,
          path.includes('/asins') ? ownMark : mark,
        );
        expect(response.statusCode).toBe(500);
        expect(response.body).not.toContain('private history');
        expect(await business()).toEqual(before);
        expect(await rows('monitor_history')).toEqual([]);
      },
    );
    it('rolls back a completed 500-row history batch and cleared exclusions when the next batch fails', async () => {
      await seed('g', 600);
      await f.pools.primaryPool.query(
        "UPDATE asins SET manual_excluded_from_group=true,manual_excluded_reason='Excluded'",
      );
      await f.pools.primaryPool.query(
        'INSERT INTO manual_history_failure_fixture VALUES(500)',
      );
      const before = await business();
      const response = await write('/variant-groups/g', {
        markedBroken: false,
      });
      expect(response.statusCode).toBe(500);
      expect(
        (
          await f.pools.primaryPool.query(
            'SELECT last_value FROM manual_history_attempt_fixture',
          )
        ).rows[0].last_value,
      ).toBe('501');
      expect(await business()).toEqual(before);
      expect(await rows('monitor_history')).toEqual([]);
    });
    it('commits every history across multiple bounded batches', async () => {
      await seed('g', 600, false);
      expect((await write('/variant-groups/g', mark)).statusCode).toBe(200);
      const history = await rows('monitor_history');
      expect(history).toHaveLength(601);
      expect(
        new Set(history.filter((row) => row.asin_id).map((row) => row.asin_id))
          .size,
      ).toBe(600);
      expect(
        history.every(
          (row) => row.is_broken && row.check_result.source === 'MANUAL_ACTION',
        ),
      ).toBe(true);
      expect(new Set(history.map((row) => row.check_time)).size).toBe(1);
    });
    it('rejects an oversized group before any state change or history attempt', async () => {
      await seed('g', 5001);
      const before = await rows('variant_groups');
      expect((await write('/variant-groups/g', mark)).statusCode).toBe(413);
      expect(await rows('variant_groups')).toEqual(before);
      expect(
        (
          await f.pools.primaryPool.query(
            'SELECT is_called FROM manual_history_attempt_fixture',
          )
        ).rows[0].is_called,
      ).toBe(false);
    });
    it.each(['/asins/missing', '/variant-groups/missing'])(
      'returns 404 without history for %s',
      async (path) => {
        expect(
          (await write(path, path.includes('/asins') ? ownMark : mark))
            .statusCode,
        ).toBe(404);
        expect(await rows('monitor_history')).toEqual([]);
      },
    );
    it('uses the current locked operator name after an administration change while waiting', async () => {
      await seed();
      const blocker = await f.pools.primaryPool.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'SELECT pg_advisory_xact_lock(1095977294,1380073795)',
        );
        await blocker.query(
          "UPDATE users SET real_name='Current actor' WHERE id=$1",
          [userId],
        );
        const response = write('/asins/a1', ownMark);
        pending = Promise.resolve(response).catch(() => {});
        await blockedBy(blocker, 'advisory');
        await blocker.query('COMMIT');
        expect((await response).statusCode).toBe(200);
        expect((await rows('monitor_history'))[0].check_result.operator).toBe(
          'Current actor',
        );
        expect((await rows('asins'))[0].manual_broken_updated_by).toBe(
          'Current actor',
        );
      } finally {
        await blocker.query('ROLLBACK');
        await pending;
        blocker.release();
      }
    });
    it.each(['/asins/a1', '/variant-groups/g'])(
      'honors cached permission revocation before %s can write state or history',
      async (path) => {
        await seed();
        expect(
          (
            await f.http.inject({
              method: 'GET',
              url: '/api/v1/variant-groups',
              headers,
            })
          ).statusCode,
        ).toBe(200);
        const before = await business();
        const blocker = await f.pools.primaryPool.connect();
        let pending: Promise<unknown> | undefined;
        try {
          await blocker.query('BEGIN');
          await blocker.query(
            'SELECT pg_advisory_xact_lock(1095977294,1380073795)',
          );
          await blocker.query(
            "DELETE FROM role_permissions rp USING permissions p WHERE rp.permission_id=p.id AND rp.role_id='writer-71' AND p.code='asin:write'",
          );
          const response = write(
            path,
            path.includes('/asins') ? ownMark : mark,
          );
          pending = Promise.resolve(response).catch(() => {});
          await blockedBy(blocker, 'advisory');
          await blocker.query('COMMIT');
          expect((await response).statusCode).toBe(403);
          expect(await business()).toEqual(before);
          expect(await rows('monitor_history')).toEqual([]);
        } finally {
          await blocker.query('ROLLBACK');
          await pending;
          blocker.release();
        }
      },
    );
    it('serializes group clear then ASIN exclusion and history snapshots through the same parent lock', async () => {
      await seed();
      const groupHeaders = { ...headers };
      await login();
      const blocker = await f.pools.primaryPool.connect();
      const pending: Promise<unknown>[] = [];
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          "SELECT id FROM variant_groups WHERE id='g' FOR UPDATE",
        );
        const clear = write(
          '/variant-groups/g',
          { markedBroken: false },
          groupHeaders,
        );
        pending.push(Promise.resolve(clear).catch(() => {}));
        await blockedBy(blocker);
        const exclude = write('/asins/a1', {
          action: 'EXCLUDE_GROUP_MANUAL',
          reason: 'After clear',
        });
        pending.push(Promise.resolve(exclude).catch(() => {}));
        await twoParents(blocker);
        await blocker.query('COMMIT');
        expect((await clear).statusCode).toBe(200);
        expect((await exclude).statusCode).toBe(200);
        const history = await rows('monitor_history');
        expect(history.map((row) => row.check_result.action)).toEqual([
          'CLEAR_MANUAL_BROKEN',
          'CLEAR_GROUP_MANUAL_BROKEN',
          'EXCLUDE_GROUP_MANUAL',
        ]);
        expect(history[2].check_result.previousStatusSource).toBe('NORMAL');
        expect((await rows('asins'))[0].manual_excluded_from_group).toBe(true);
      } finally {
        await blocker.query('ROLLBACK');
        await Promise.allSettled(pending);
        blocker.release();
      }
    });
    it('rejects a manual action whose candidate ASIN was moved while waiting without writing history', async () => {
      await seed();
      await seed('target', 0);
      const moverHeaders = { ...headers };
      await login();
      const blocker = await f.pools.primaryPool.connect();
      const pending: Promise<unknown>[] = [];
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          "SELECT id FROM variant_groups WHERE id='g' FOR UPDATE",
        );
        const move = f.http.inject({
          method: 'POST',
          url: '/api/v1/asins/a1/move',
          headers: moverHeaders,
          payload: { targetGroupId: 'target' },
        });
        pending.push(Promise.resolve(move).catch(() => {}));
        await blockedBy(blocker);
        const manual = write('/asins/a1', ownMark);
        pending.push(Promise.resolve(manual).catch(() => {}));
        await twoParents(blocker);
        await blocker.query('COMMIT');
        expect((await move).statusCode).toBe(200);
        expect((await manual).statusCode).toBe(409);
        expect((await rows('asins'))[0]).toMatchObject({
          variant_group_id: 'target',
          manual_broken: false,
        });
        expect(await rows('monitor_history')).toEqual([]);
      } finally {
        await blocker.query('ROLLBACK');
        await Promise.allSettled(pending);
        blocker.release();
      }
    });
    it('uses a database operation clock after the parent lock and preserves newer timestamp ordering', async () => {
      await seed();
      const blocker = await f.pools.primaryPool.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          "SELECT id FROM variant_groups WHERE id='g' FOR UPDATE",
        );
        const response = write('/asins/a1', ownMark);
        pending = Promise.resolve(response).catch(() => {});
        await blockedBy(blocker);
        const newer = await blocker.query(
          "UPDATE variant_groups SET name='New snapshot' WHERE id='g' RETURNING extract(epoch FROM update_time)::text AS time",
        );
        await blocker.query('COMMIT');
        expect((await response).statusCode).toBe(200);
        expect(
          (
            await f.pools.primaryPool.query(
              "SELECT update_time >= to_timestamp($1::numeric) AT TIME ZONE 'UTC' AS valid FROM variant_groups WHERE id='g'",
              [newer.rows[0].time],
            )
          ).rows[0].valid,
        ).toBe(true);
        const history = (await rows('monitor_history'))[0];
        expect(history.variant_group_name).toBe('New snapshot');
        expect(
          new Date(`${history.check_time}+08:00`).getTime(),
        ).toBeGreaterThanOrEqual(
          Number(newer.rows[0].time) * 1000 - 8 * 3600000 - 1,
        );
      } finally {
        await blocker.query('ROLLBACK');
        await pending;
        blocker.release();
      }
    });
  },
);
