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
  'ASIN writes / real constraints, PostgreSQL and Redis',
  () => {
    let f: Awaited<ReturnType<typeof asinWriteApp>>;
    let operatorId: string;
    let headers: { authorization: string; origin: string };
    const groupBody = {
      name: 'Group',
      country: 'US',
      site: 'amazon.com',
      brand: 'Fixture',
    };
    const asinBody = {
      asin: 'B000000085',
      name: 'Product',
      country: 'US',
      site: 'amazon.com',
      brand: 'Fixture',
      asinType: '1',
    };
    beforeAll(async () => {
      f = await asinWriteApp();
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
      await f.pools.primaryPool.query(
        'ALTER TABLE asins ENABLE TRIGGER trg_asins_update_time',
      );
      await f.pools.primaryPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT 'writer-71',id FROM permissions WHERE code='asin:write' ON CONFLICT DO NOTHING",
      );
      operatorId = randomUUID();
      const sessionId = randomUUID();
      f.userIds.add(operatorId);
      await f.pools.primaryPool.query(
        'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$2,$3,false)',
        [operatorId, `u85-${operatorId}`, 'fixture-unused-hash'],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO user_roles(user_id,role_id) VALUES($1,'writer-71')",
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
        origin: f.env.CORS_ORIGIN,
      };
    });
    const write = (
      method: 'POST' | 'PUT',
      path: string,
      payload: Record<string, unknown>,
    ) => f.http.inject({ method, url: `/api/v1${path}`, headers, payload });
    async function group(id: string, manual = false) {
      await f.pools.primaryPool.query(
        "INSERT INTO variant_groups(id,name,country,site,brand,manual_broken,manual_broken_reason,create_time,update_time) VALUES($1,$1,'US','amazon.com','Fixture',$2,$3,'2020-01-01 08:00:00','2020-01-01 08:00:00')",
        [id, manual, manual ? 'parent reason' : null],
      );
    }
    async function asin(id: string, parent: string) {
      await f.pools.primaryPool.query(
        "INSERT INTO asins(id,asin,name,country,site,brand,variant_group_id,create_time,update_time) VALUES($1,$1,'Product','US','amazon.com','Fixture',$2,'2020-01-01 08:00:00','2020-01-01 08:00:00')",
        [id, parent],
      );
    }
    const rows = async (table: 'asins' | 'variant_groups') =>
      (
        await f.pools.primaryPool.query(
          `SELECT row_to_json(t) AS data FROM ${table} t ORDER BY id`,
        )
      ).rows.map((row) => row.data);
    async function blockedBy(
      connection: PoolClient,
      kind = 'transactionid',
      minimum = 1,
    ) {
      await vi.waitFor(
        async () => {
          const result = await connection.query(
            'SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND locktype=$1 AND pg_backend_pid()=ANY(pg_blocking_pids(pid))',
            [kind],
          );
          expect(result.rows[0].n).toBeGreaterThanOrEqual(minimum);
        },
        { timeout: 1000, interval: 10 },
      );
    }
    it('creates a group with real defaults, then edits only group fields and returns the complete contract', async () => {
      const created = await write('POST', '/variant-groups', groupBody);
      expect(created.statusCode).toBe(200);
      expect(created.headers['cache-control']).toBe('no-store');
      const record = variantGroupResultSchema.parse(created.json()).data!;
      expect(record).toMatchObject({
        ...groupBody,
        isBroken: 0,
        statusSource: 'NORMAL',
        children: [],
      });
      expect(new Date(record.createTime!).getTime()).toBeGreaterThan(
        Date.parse('2026-01-01'),
      );
      await asin('a', record.id);
      const childBefore = await rows('asins');
      const changed = await write('PUT', `/variant-groups/${record.id}`, {
        ...groupBody,
        name: 'New group',
        country: 'UK',
        site: 'amazon.co.uk',
        brand: 'New brand',
      });
      expect(changed.statusCode).toBe(200);
      expect(variantGroupResultSchema.parse(changed.json()).data).toMatchObject(
        {
          id: record.id,
          country: 'UK',
          children: [{ id: 'a', country: 'US' }],
        },
      );
      expect(await rows('asins')).toEqual(childBefore);
    });
    it('creates an ASIN, inherits current parent state and touches the parent in the same transaction', async () => {
      await group('g', true);
      const response = await write('POST', '/asins', {
        ...asinBody,
        parentId: 'g',
      });
      expect(response.statusCode).toBe(200);
      const record = asinRecordResultSchema.parse(response.json()).data!;
      expect(record).toMatchObject({
        ...asinBody,
        parentId: 'g',
        variantGroupId: 'g',
        manualBroken: 1,
        inheritedManualBroken: 1,
        selfManualBroken: 0,
        statusSource: 'MANUAL',
      });
      expect((await rows('asins'))[0]).toMatchObject({
        variant_group_id: 'g',
        asin_type: '1',
        manual_broken: false,
      });
      expect((await rows('variant_groups'))[0].update_time).not.toBe(
        '2020-01-01T08:00:00',
      );
    });
    it('updates only ASIN editable fields, preserves metadata and leaves the parent timestamp unchanged', async () => {
      await group('g', true);
      await asin('a', 'g');
      await f.pools.primaryPool.query(
        "UPDATE asins SET manual_broken=true,manual_broken_reason='self reason',manual_excluded_from_group=true,manual_excluded_reason='exclusion',last_check_time='2020-02-01 08:00:00',update_time='2020-03-01 08:00:00'",
      );
      const before = await rows('variant_groups');
      const result = await write('PUT', '/asins/a', {
        ...asinBody,
        name: null,
        asinType: 2,
      });
      expect(result.statusCode).toBe(200);
      expect(asinRecordResultSchema.parse(result.json()).data).toMatchObject({
        id: 'a',
        name: null,
        asinType: '2',
        selfManualBroken: 1,
        selfManualBrokenReason: 'self reason',
        manualExcludedFromGroup: 1,
        lastCheckTime: '2020-02-01T00:00:00.000Z',
      });
      expect(await rows('variant_groups')).toEqual(before);
    });
    it.each([false, true])(
      'moves an ASIN with metadata preserved, parent times touched and new inheritance (same target=%s)',
      async (same) => {
        await group('source');
        await group('target', true);
        await asin('a', 'source');
        await f.pools.primaryPool.query(
          "UPDATE asins SET manual_excluded_from_group=true,manual_excluded_reason='retained',manual_broken_reason='historical',update_time='2020-03-01 08:00:00'",
        );
        const before = (await rows('asins'))[0];
        const target = same ? 'source' : 'target';
        const response = await write('POST', '/asins/a/move', {
          targetGroupId: target,
        });
        expect(response.statusCode).toBe(200);
        expect(
          asinRecordResultSchema.parse(response.json()).data,
        ).toMatchObject({
          parentId: target,
          variantGroupId: target,
          country: 'US',
          manualExcludedFromGroup: 1,
          manualExcludedReason: 'retained',
          isBroken: 0,
        });
        const after = (await rows('asins'))[0];
        expect({
          ...after,
          variant_group_id: before.variant_group_id,
          update_time: before.update_time,
        }).toEqual(before);
        const parents = await rows('variant_groups');
        expect(parents.find((row) => row.id === 'source').update_time).not.toBe(
          '2020-01-01T08:00:00',
        );
        expect(
          parents.find((row) => row.id === 'target').update_time ===
            '2020-01-01T08:00:00',
        ).toBe(same);
      },
    );
    it('uses the target parent current manual state after a move without rewriting ASIN country', async () => {
      await group('source');
      await group('target', true);
      await asin('a', 'source');
      await f.pools.primaryPool.query(
        "UPDATE variant_groups SET country='UK' WHERE id='target'",
      );
      const response = await write('POST', '/asins/a/move', {
        targetGroupId: 'target',
      });
      expect(response.statusCode).toBe(200);
      expect(asinRecordResultSchema.parse(response.json()).data).toMatchObject({
        country: 'US',
        parentId: 'target',
        inheritedManualBroken: 1,
        manualBrokenScope: 'GROUP',
        statusSource: 'MANUAL',
      });
    });
    it('resolves concurrent case-insensitive duplicates across different parents with one commit and one 409', async () => {
      await group('g1');
      await group('g2');
      const results = await Promise.all([
        write('POST', '/asins', { ...asinBody, parentId: 'g1' }),
        write('POST', '/asins', {
          ...asinBody,
          asin: asinBody.asin.toLowerCase(),
          country: 'us',
          parentId: 'g2',
        }),
      ]);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
      const items = await rows('asins');
      expect(items).toHaveLength(1);
      const touched = (await rows('variant_groups')).filter(
        (row) => row.update_time !== '2020-01-01T08:00:00',
      );
      expect(touched.map((row) => row.id)).toEqual([items[0].variant_group_id]);
    });
    it('rolls back duplicate ASIN edits and returns a fixed conflict without driver details', async () => {
      await group('g');
      await asin('A', 'g');
      await asin('B', 'g');
      const before = await rows('asins');
      const response = await write('PUT', '/asins/B', {
        ...asinBody,
        asin: 'a',
        country: 'us',
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().errorMessage).toBe('该 ASIN 在此国家中已存在');
      expect(await rows('asins')).toEqual(before);
    });
    it('rolls back a newly inserted ASIN if touching its parent fails', async () => {
      await group('g-fail-touch');
      const before = await rows('variant_groups');
      const response = await write('POST', '/asins', {
        ...asinBody,
        parentId: 'g-fail-touch',
      });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('fixture parent touch failure');
      expect(await rows('asins')).toEqual([]);
      expect(await rows('variant_groups')).toEqual(before);
    });
    it('rolls back a move and both parent touches if the target touch fails', async () => {
      await group('source');
      await group('g-fail-touch');
      await asin('a', 'source');
      const before = await Promise.all([rows('asins'), rows('variant_groups')]);
      const response = await write('POST', '/asins/a/move', {
        targetGroupId: 'g-fail-touch',
      });
      expect(response.statusCode).toBe(500);
      expect(
        await Promise.all([rows('asins'), rows('variant_groups')]),
      ).toEqual(before);
    });
    it('rolls back group edits when the complete response would exceed the 5000-child bound', async () => {
      await group('g');
      await f.pools.primaryPool.query(
        "INSERT INTO asins(id,asin,country,site,brand,variant_group_id) SELECT 'a'||n,'B'||n,'US','amazon.com','Fixture','g' FROM generate_series(1,5001) n",
      );
      const before = await rows('variant_groups');
      const response = await write('PUT', '/variant-groups/g', {
        ...groupBody,
        name: 'Must roll back',
      });
      expect(response.statusCode).toBe(413);
      expect(await rows('variant_groups')).toEqual(before);
    });
    it.each([
      ['PUT', '/variant-groups/missing', groupBody],
      ['POST', '/asins', { ...asinBody, parentId: 'missing' }],
      ['PUT', '/asins/missing', asinBody],
      ['POST', '/asins/missing/move', { targetGroupId: 'g' }],
      ['POST', '/asins/a/move', { targetGroupId: 'missing' }],
    ] as const)(
      'returns 404 atomically for %s %s',
      async (method, path, payload) => {
        await group('g');
        await asin('a', 'g');
        const before = await Promise.all([
          rows('asins'),
          rows('variant_groups'),
        ]);
        expect((await write(method, path, payload)).statusCode).toBe(404);
        expect(
          await Promise.all([rows('asins'), rows('variant_groups')]),
        ).toEqual(before);
      },
    );
    it('completes opposite moves with the same parent lock ordering', async () => {
      await group('g1');
      await group('g2');
      await asin('a', 'g1');
      await asin('b', 'g2');
      const responses = await Promise.all([
        write('POST', '/asins/a/move', { targetGroupId: 'g2' }),
        write('POST', '/asins/b/move', { targetGroupId: 'g1' }),
      ]);
      expect(responses.map((r) => r.statusCode)).toEqual([200, 200]);
      expect(
        (await rows('asins')).map((row) => [row.id, row.variant_group_id]),
      ).toEqual([
        ['a', 'g2'],
        ['b', 'g1'],
      ]);
    });
    it('returns a parent-changed conflict for a competing move after both observed the old parent', async () => {
      await group('a-source');
      await group('b-target');
      await group('c-target');
      await asin('a', 'a-source');
      const blocker = await f.pools.primaryPool.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          "SELECT id FROM variant_groups WHERE id='a-source' FOR UPDATE",
        );
        const responses = Promise.all([
          write('POST', '/asins/a/move', { targetGroupId: 'b-target' }),
          write('POST', '/asins/a/move', { targetGroupId: 'c-target' }),
        ]);
        pending = responses.catch(() => {});
        // One waiter may be queued on the first waiter's tuple lock; count all
        // blocked application sessions, and prove both passed their source read.
        await vi.waitFor(
          async () => {
            const result = await blocker.query(
              "SELECT count(DISTINCT pid)::int AS n FROM pg_locks WHERE NOT granted AND locktype IN ('tuple','transactionid') AND array_length(pg_blocking_pids(pid),1)>0 AND pid IN (SELECT pid FROM pg_locks WHERE relation=to_regclass('variant_groups') AND granted AND mode='RowShareLock')",
            );
            expect(result.rows[0].n).toBeGreaterThanOrEqual(2);
          },
          { timeout: 1000, interval: 10 },
        );
        await blocker.query('COMMIT');
        const completed = await responses;
        expect(completed.map((r) => r.statusCode).sort()).toEqual([200, 409]);
        expect(
          completed.find((r) => r.statusCode === 409)!.json().errorMessage,
        ).toBe('ASIN 所属变体组已改变，请刷新后重试');
        const winner = completed.find((r) => r.statusCode === 200)!.json()
          .data.parentId;
        expect((await rows('asins'))[0].variant_group_id).toBe(winner);
        const untouched = winner === 'b-target' ? 'c-target' : 'b-target';
        expect(
          (await rows('variant_groups')).find((row) => row.id === untouched)
            .update_time,
        ).toBe('2020-01-01T08:00:00');
      } finally {
        await blocker.query('ROLLBACK');
        await pending;
        blocker.release();
      }
    });
    it('uses a post-lock statement time for parent touches after waiting behind a newer modification', async () => {
      await group('g');
      const blocker = await f.pools.primaryPool.connect();
      let pending: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          "SELECT id FROM variant_groups WHERE id='g' FOR UPDATE",
        );
        const request = write('POST', '/asins', { ...asinBody, parentId: 'g' });
        pending = Promise.resolve(request).catch(() => {});
        await blockedBy(blocker);
        const newer = await blocker.query(
          "UPDATE variant_groups SET name='newer blocker' WHERE id='g' RETURNING extract(epoch FROM update_time)::text AS time",
        );
        await blocker.query('COMMIT');
        expect((await request).statusCode).toBe(200);
        const actual = await f.pools.primaryPool.query(
          "SELECT extract(epoch FROM update_time) >= $1::numeric AS valid FROM variant_groups WHERE id='g'",
          [newer.rows[0].time],
        );
        expect(actual.rows[0].valid).toBe(true);
      } finally {
        await blocker.query('ROLLBACK');
        await pending;
        blocker.release();
      }
    });
    it('rechecks cached permissions after an administration transaction revokes them while the write waits', async () => {
      await group('g');
      expect(
        (
          await f.http.inject({
            method: 'GET',
            url: '/api/v1/variant-groups',
            headers,
          })
        ).statusCode,
      ).toBe(200);
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
        const request = write('POST', '/asins', { ...asinBody, parentId: 'g' });
        pending = Promise.resolve(request).catch(() => {});
        await blockedBy(blocker, 'advisory');
        await blocker.query('COMMIT');
        expect((await request).statusCode).toBe(403);
        expect(await rows('asins')).toEqual([]);
        expect((await rows('variant_groups'))[0].update_time).toBe(
          '2020-01-01T08:00:00',
        );
      } finally {
        await blocker.query('ROLLBACK');
        await pending;
        blocker.release();
      }
    });
    it('rejects an unavailable timestamp policy before any business writes and keeps reads available', async () => {
      await group('g');
      await f.pools.primaryPool.query(
        'ALTER TABLE asins DISABLE TRIGGER trg_asins_update_time',
      );
      const before = await rows('variant_groups');
      const response = await write('POST', '/asins', {
        ...asinBody,
        parentId: 'g',
      });
      expect(response.statusCode).toBe(503);
      expect(await rows('asins')).toEqual([]);
      expect(await rows('variant_groups')).toEqual(before);
      expect(
        (
          await f.http.inject({
            method: 'GET',
            url: '/api/v1/variant-groups',
            headers,
          })
        ).statusCode,
      ).toBe(200);
    });
  },
);
