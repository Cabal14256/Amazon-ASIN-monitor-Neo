import {
  competitorAsinRecordResultSchema,
  competitorGroupResultSchema,
} from '@asin-monitor/contracts';
import { createPgPool, PgCompetitorWriteRepository } from '@asin-monitor/db';
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
import { legacyCompetitorQueryFixture } from './helpers/competitor-query-legacy';
import { competitorWriteApp } from './helpers/competitor-write-app';

/** Compare every key and value. Only newly generated database clock readings
 * tolerate MySQL's second precision and the time between sequential requests.
 * Historical fixture timestamps, NULLs and unchanged fields remain exact. */
function complete(actual: unknown, expected: unknown) {
  if (
    typeof expected === 'string' &&
    /^20\d\d-\d\d-\d\dT/.test(expected) &&
    !expected.startsWith('2020-')
  ) {
    expect(typeof actual).toBe('string');
    expect(
      Math.abs(Date.parse(actual as string) - Date.parse(expected)),
    ).toBeLessThan(2000);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual)).toBe(true);
    expect((actual as unknown[]).length).toBe(expected.length);
    expected.forEach((value, index) =>
      complete((actual as unknown[])[index], value),
    );
    return;
  }
  if (expected && typeof expected === 'object') {
    expect(actual).toBeTypeOf('object');
    expect(Object.keys(actual as object).sort()).toEqual(
      Object.keys(expected).sort(),
    );
    for (const [key, value] of Object.entries(expected))
      complete((actual as Record<string, unknown>)[key], value);
    return;
  }
  expect(actual).toEqual(expected);
}

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'competitor writes / actual Legacy MySQL, primary auth and competitor PG transactions',
  () => {
    let f: Awaited<ReturnType<typeof competitorWriteApp>>,
      legacy: Awaited<ReturnType<typeof legacyCompetitorQueryFixture>>;
    let userId: string, sessionId: string, headers: { authorization: string };
    const groupBody = { name: 'Group', country: 'US', brand: 'Parent brand' };
    const asinBody = {
      asin: 'B000000121',
      country: 'US',
      brand: 'Own brand',
      asinType: '1',
      parentId: 'g1',
    };
    beforeAll(async () => {
      f = await competitorWriteApp();
      legacy = await legacyCompetitorQueryFixture();
    });
    afterAll(async () => {
      try {
        await f?.close();
      } finally {
        await legacy?.close();
        vi.restoreAllMocks();
      }
    });
    beforeEach(async () => {
      for (const table of [
        'competitor_monitor_history',
        'competitor_asins',
        'competitor_variant_groups',
      ]) {
        await f.pools.competitorPool.query(`DELETE FROM ${table}`);
        await legacy.query(`DELETE FROM ${table}`);
      }
      userId = randomUUID();
      sessionId = randomUUID();
      f.userIds.add(userId);
      await f.pools.primaryPool.query(
        'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$1,$2,false)',
        [userId, 'fixture-unused-hash'],
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
      };
    });
    const request = (
      method: 'POST' | 'PUT' | 'DELETE',
      path: string,
      payload: unknown = undefined,
    ) =>
      f.http.inject({
        method,
        url: `/api/v1/competitor/${path}`,
        headers,
        payload: payload as Record<string, unknown>,
      });
    const read = () =>
      f.http.inject({
        method: 'GET',
        url: '/api/v1/competitor/variant-groups',
        headers,
      });
    async function group(id: string, country = 'US') {
      const values = [id, `Group ${id}`, country, 'Parent brand'];
      await f.pools.competitorPool.query(
        "INSERT INTO competitor_variant_groups(id,name,country,brand,create_time,update_time) VALUES($1,$2,$3,$4,'2020-01-01 08:00:00','2020-01-01 08:00:00')",
        values,
      );
      await legacy.query(
        "INSERT INTO competitor_variant_groups(id,name,country,brand,create_time,update_time) VALUES(?,?,?,?,'2020-01-01 08:00:00','2020-01-01 08:00:00')",
        values,
      );
    }
    async function asin(
      id: string,
      parent = 'g1',
      country = 'US',
      code = 'B' + id.toUpperCase().padStart(9, '0'),
    ) {
      const values = [id, code, country, 'Own brand', parent];
      await f.pools.competitorPool.query(
        "INSERT INTO competitor_asins(id,asin,country,brand,variant_group_id,is_broken,variant_status,feishu_notify_enabled,create_time,update_time) VALUES($1,$2,$3,$4,$5,true,'BROKEN',NULL,'2020-01-01 08:00:00','2020-01-01 08:00:00')",
        values,
      );
      await legacy.query(
        "INSERT INTO competitor_asins(id,asin,country,brand,variant_group_id,is_broken,variant_status,feishu_notify_enabled,create_time,update_time) VALUES(?,?,?,?,?,1,'BROKEN',NULL,'2020-01-01 08:00:00','2020-01-01 08:00:00')",
        values,
      );
    }
    async function snapshot() {
      return {
        groups: (
          await f.pools.competitorPool.query(
            'SELECT * FROM competitor_variant_groups ORDER BY id',
          )
        ).rows,
        asins: (
          await f.pools.competitorPool.query(
            'SELECT * FROM competitor_asins ORDER BY id',
          )
        ).rows,
      };
    }
    async function compare(
      response: Awaited<ReturnType<typeof request>>,
      source: Awaited<ReturnType<typeof legacy.createGroup>>,
      groupResult = false,
    ) {
      expect(response.statusCode).toBe(source.statusCode);
      complete(response.json(), source.body);
      if (response.statusCode === 200) {
        (groupResult
          ? competitorGroupResultSchema
          : competitorAsinRecordResultSchema
        ).parse(response.json());
        expect(response.headers['cache-control']).toBe('no-store');
      }
      return response.json();
    }
    async function blocked(client: PoolClient) {
      await vi.waitFor(
        async () => {
          expect(
            (
              await client.query(
                'SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND pg_backend_pid()=ANY(pg_blocking_pids(pid))',
              )
            ).rows[0].n,
          ).toBeGreaterThan(0);
        },
        { timeout: 1000, interval: 10 },
      );
    }
    const actionCases = [
      {
        method: 'DELETE',
        path: 'variant-groups/g1',
        source: () => legacy.deleteGroup('g1'),
      },
      {
        method: 'DELETE',
        path: 'asins/a1',
        source: () => legacy.deleteAsin('a1'),
      },
      {
        method: 'PUT',
        path: 'variant-groups/g1/feishu-notify',
        source: () => legacy.updateGroupNotify('g1', { enabled: true }),
      },
      {
        method: 'PUT',
        path: 'asins/a1/feishu-notify',
        source: () => legacy.updateAsinNotify('a1', { enabled: true }),
      },
    ] as const;
    async function history() {
      const values = ['g1', 'Group snapshot', 'a1', 'B0000000A1', 'US'];
      await f.pools.competitorPool.query(
        "INSERT INTO competitor_monitor_history(variant_group_id,variant_group_name,asin_id,asin_code,country,check_time,check_result,create_time) VALUES($1,$2,$3,$4,$5,'2020-01-01 08:00:00','{\"fixture\":true}','2020-01-01 08:00:00')",
        values,
      );
      await legacy.query(
        "INSERT INTO competitor_monitor_history(variant_group_id,variant_group_name,asin_id,asin_code,country,check_time,check_result,create_time) VALUES(?,?,?,?,?,'2020-01-01 08:00:00','{\"fixture\":true}','2020-01-01 08:00:00')",
        values,
      );
    }
    async function histories() {
      return {
        neo: (
          await f.pools.competitorPool.query(
            'SELECT * FROM competitor_monitor_history ORDER BY id',
          )
        ).rows,
        legacy: await legacy.query(
          'SELECT * FROM competitor_monitor_history ORDER BY id',
        ),
      };
    }
    it.each(actionCases)(
      'returns the complete Legacy missing-record result for $method $path',
      async (value) => {
        const response = await request(
          value.method,
          value.path,
          value.method === 'PUT' ? { enabled: true } : undefined,
        );
        const source = await value.source();
        expect(response.statusCode).toBe(404);
        expect(response.statusCode).toBe(source.statusCode);
        complete(response.json(), source.body);
      },
    );
    it.each(actionCases)(
      'rechecks current primary permission before $method $path with cached guard grants',
      async (value) => {
        await group('g1');
        await asin('a1');
        const before = await snapshot();
        expect((await read()).statusCode).toBe(200);
        await f.pools.primaryPool.query(
          'DELETE FROM user_roles WHERE user_id=$1',
          [userId],
        );
        expect(
          (
            await request(
              value.method,
              value.path,
              value.method === 'PUT' ? { enabled: true } : undefined,
            )
          ).statusCode,
        ).toBe(403);
        expect(await snapshot()).toEqual(before);
      },
    );
    it('deletes a group and its real FK children while retaining both Legacy and Neo histories', async () => {
      await group('g1');
      await group('g2');
      await asin('a1');
      await asin('a2', 'g2');
      await history();
      const before = await snapshot(),
        savedHistory = await histories();
      const response = await request('DELETE', 'variant-groups/g1'),
        source = await legacy.deleteGroup('g1');
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      complete(response.json(), source.body);
      expect(response.json().data).toBe('删除成功');
      const after = await snapshot();
      expect(after.groups).toEqual(
        before.groups.filter((row) => row.id === 'g2'),
      );
      expect(after.asins).toEqual(
        before.asins.filter((row) => row.id === 'a2'),
      );
      expect(await histories()).toEqual(savedHistory);
      expect(
        await legacy.query('SELECT id FROM competitor_asins ORDER BY id'),
      ).toEqual([{ id: 'a2' }]);
      expect(
        (
          await f.pools.primaryPool.query(
            'SELECT * FROM competitor_variant_groups',
          )
        ).rows,
      ).toEqual([{ id: 'g1', name: 'wrong-primary-data' }]);
    });
    it('deletes only the target ASIN, touches its parent and preserves historical records', async () => {
      await group('g1');
      await asin('a1');
      await asin('a2');
      await history();
      const before = await snapshot(),
        savedHistory = await histories();
      const response = await request('DELETE', 'asins/a1'),
        source = await legacy.deleteAsin('a1');
      expect(response.statusCode).toBe(200);
      complete(response.json(), source.body);
      expect((await snapshot()).asins).toEqual(
        before.asins.filter((row) => row.id === 'a2'),
      );
      expect(await histories()).toEqual(savedHistory);
      const detail = await f.http.inject({
        method: 'GET',
        url: '/api/v1/competitor/variant-groups/g1',
        headers,
      });
      complete(detail.json(), (await legacy.detail('g1')).body);
      expect((await snapshot()).groups[0].update_time).not.toEqual(
        before.groups[0].update_time,
      );
    });
    it.each([true, false, 0, 1])(
      'changes only the group notification fields for Legacy input %s',
      async (enabled) => {
        await group('g1');
        await asin('a1');
        const before = await snapshot(),
          body = { enabled };
        await compare(
          await request('PUT', 'variant-groups/g1/feishu-notify', body),
          await legacy.updateGroupNotify('g1', body),
          true,
        );
        const after = await snapshot();
        expect(after.asins).toEqual(before.asins);
        expect(after.groups[0]).toEqual({
          ...before.groups[0],
          feishu_notify_enabled: enabled === true || enabled === 1,
          update_time: after.groups[0].update_time,
        });
        expect(after.groups[0].update_time).not.toEqual(
          before.groups[0].update_time,
        );
      },
    );
    it.each([true, false, 0, 1])(
      'changes only the ASIN notification fields and keeps the parent time for %s',
      async (enabled) => {
        await group('g1');
        await asin('a1');
        await asin('a2');
        const before = await snapshot(),
          body = { enabled };
        await compare(
          await request('PUT', 'asins/a1/feishu-notify', body),
          await legacy.updateAsinNotify('a1', body),
        );
        const after = await snapshot();
        expect(after.groups).toEqual(before.groups);
        expect(after.asins[1]).toEqual(before.asins[1]);
        expect(after.asins[0]).toEqual({
          ...before.asins[0],
          feishu_notify_enabled: enabled === true || enabled === 1,
          update_time: after.asins[0].update_time,
        });
        expect(after.asins[0].update_time).not.toEqual(
          before.asins[0].update_time,
        );
      },
    );
    it.each([null, '', 'false', 'true', '0', '1', 2, {}])(
      'matches the full Legacy invalid enabled response for %j',
      async (enabled) => {
        await group('g1');
        await asin('a1');
        const before = await snapshot(),
          body = { enabled };
        await compare(
          await request('PUT', 'variant-groups/g1/feishu-notify', body),
          await legacy.updateGroupNotify('g1', body),
        );
        await compare(
          await request('PUT', 'asins/a1/feishu-notify', body),
          await legacy.updateAsinNotify('a1', body),
        );
        expect(await snapshot()).toEqual(before);
      },
    );
    it('uses the same real CI/accent/PADSPACE identity for notification changes and deletion', async () => {
      await group('Gróup ');
      await asin('Ásin ', 'Gróup ');
      const response = await request('PUT', 'asins/ASIN/feishu-notify', {
        enabled: true,
      });
      await compare(
        response,
        await legacy.updateAsinNotify('ASIN', { enabled: true }),
      );
      expect(response.json().data.variantGroupId).toBe('Gróup ');
      const deleted = await request('DELETE', 'variant-groups/GROUP');
      expect(deleted.statusCode).toBe(200);
      complete(deleted.json(), (await legacy.deleteGroup('GROUP')).body);
      expect(await snapshot()).toEqual({ groups: [], asins: [] });
    });
    it('rolls back ASIN deletion when its parent timestamp update fails', async () => {
      await group('g1');
      await asin('a1');
      await history();
      const before = await snapshot(),
        savedHistory = await histories();
      await f.pools.competitorPool.query(
        "CREATE FUNCTION fail_competitor_delete_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-delete-touch'; END $$; CREATE TRIGGER fail_competitor_delete_touch AFTER UPDATE ON competitor_variant_groups FOR EACH ROW EXECUTE FUNCTION fail_competitor_delete_touch()",
      );
      try {
        const response = await request('DELETE', 'asins/a1');
        expect(response.statusCode).toBe(500);
        expect(
          response.body + JSON.stringify(f.logger.error.mock.calls),
        ).not.toContain('private-delete-touch');
        expect(await snapshot()).toEqual(before);
        expect(await histories()).toEqual(savedHistory);
      } finally {
        await f.pools.competitorPool.query(
          'DROP TRIGGER fail_competitor_delete_touch ON competitor_variant_groups; DROP FUNCTION fail_competitor_delete_touch()',
        );
      }
      expect((await request('DELETE', 'asins/a1')).statusCode).toBe(200);
    });
    it('rolls back the complete group cascade when a child deletion fails', async () => {
      await group('g1');
      await asin('a1');
      await asin('a2');
      await history();
      const before = await snapshot(),
        savedHistory = await histories();
      await f.pools.competitorPool.query(
        "CREATE FUNCTION fail_competitor_child_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.id='a2' THEN RAISE EXCEPTION 'private-child-delete'; END IF; RETURN OLD; END $$; CREATE TRIGGER fail_competitor_child_delete AFTER DELETE ON competitor_asins FOR EACH ROW EXECUTE FUNCTION fail_competitor_child_delete()",
      );
      try {
        expect((await request('DELETE', 'variant-groups/g1')).statusCode).toBe(
          500,
        );
        expect(await snapshot()).toEqual(before);
        expect(await histories()).toEqual(savedHistory);
      } finally {
        await f.pools.competitorPool.query(
          'DROP TRIGGER fail_competitor_child_delete ON competitor_asins; DROP FUNCTION fail_competitor_child_delete()',
        );
      }
      expect((await request('DELETE', 'variant-groups/g1')).statusCode).toBe(
        200,
      );
    });
    it('does not delete a child moved while waiting for the original parent lock', async () => {
      await group('g1');
      await group('g2');
      await asin('a1');
      const blocker = await f.pools.competitorPool.connect();
      let pending: Promise<Awaited<ReturnType<typeof request>>> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          "SELECT id FROM competitor_variant_groups WHERE id='g1' FOR UPDATE",
        );
        pending = Promise.resolve(request('DELETE', 'asins/a1'));
        await blocked(blocker);
        await blocker.query(
          "UPDATE competitor_asins SET variant_group_id='g2' WHERE id='a1'",
        );
        await blocker.query('COMMIT');
        expect((await pending).statusCode).toBe(409);
        expect((await snapshot()).asins).toEqual([
          expect.objectContaining({ id: 'a1', variant_group_id: 'g2' }),
        ]);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await pending?.catch(() => {});
      }
    });
    it('does not commit a notification change when the complete group response exceeds the child bound', async () => {
      await group('g1');
      await f.pools.competitorPool.query(
        "INSERT INTO competitor_asins(id,asin,country,brand,variant_group_id) SELECT 'large-'||n,'B'||lpad(n::text,9,'0'),'US','Fixture','g1' FROM generate_series(1,5001)n",
      );
      const before = await snapshot();
      expect(
        (
          await request('PUT', 'variant-groups/g1/feishu-notify', {
            enabled: true,
          })
        ).statusCode,
      ).toBe(413);
      expect(await snapshot()).toEqual(before);
    });
    it('creates a complete group in the distinct competitor database using the actual source controller', async () => {
      const body = { ...groupBody, country: ' us ' };
      const response = await request('POST', 'variant-groups', body);
      expect(response.statusCode).toBe(200);
      const id = response.json().data.id;
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      legacy.useGeneratedId(id);
      await compare(response, await legacy.createGroup(body), true);
      expect(response.json().data).toMatchObject({
        country: 'US',
        feishuNotifyEnabled: 0,
        children: [],
      });
      expect(
        (
          await f.pools.primaryPool.query(
            'SELECT * FROM competitor_variant_groups',
          )
        ).rows,
      ).toEqual([{ id: 'g1', name: 'wrong-primary-data' }]);
    });
    it.each([undefined, null, '', 0, false, 1, 2, '1', '2'])(
      'creates the full standalone ASIN with Legacy type input %s',
      async (asinType) => {
        await group('g1');
        const body = {
          ...asinBody,
          asin: ' b000000121 ',
          country: ' us ',
          asinType,
          name: '',
        };
        const response = await request('POST', 'asins', body);
        expect(response.statusCode).toBe(200);
        legacy.useGeneratedId(response.json().data.id);
        await compare(response, await legacy.createAsin(body));
        expect(response.json().data).not.toHaveProperty('parentId');
        const detail = await f.http.inject({
          method: 'GET',
          url: '/api/v1/competitor/variant-groups/g1',
          headers,
        });
        complete(detail.json(), (await legacy.detail('g1')).body);
      },
    );
    it('changes a group country and all child countries without inheriting its brand or resetting state', async () => {
      await group('g1');
      await asin('a1');
      await asin('a2');
      const body = {
        name: 'Renamed',
        country: ' uk ',
        brand: 'New parent brand',
      };
      await compare(
        await request('PUT', 'variant-groups/g1', body),
        await legacy.updateGroup('g1', body),
        true,
      );
      expect((await snapshot()).asins).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'a1',
            country: 'UK',
            brand: 'Own brand',
            is_broken: true,
            feishu_notify_enabled: null,
          }),
        ]),
      );
    });
    it('keeps child timestamps and brand unchanged when only parent metadata changes', async () => {
      await group('g1');
      await asin('a1');
      const before = await snapshot();
      const body = { ...groupBody, name: 'Renamed', brand: 'New parent brand' };
      await compare(
        await request('PUT', 'variant-groups/g1', body),
        await legacy.updateGroup('g1', body),
        true,
      );
      expect((await snapshot()).asins).toEqual(before.asins);
    });
    it('rejects country changes with an existing equivalent ASIN and preserves every original row', async () => {
      await group('g1');
      await group('g2', 'UK');
      await asin('a1', 'g1', 'US', 'CAFÉ');
      await asin('a2', 'g2', 'UK', 'CAFE');
      const before = await snapshot(),
        body = { ...groupBody, country: 'UK' };
      const response = await request('PUT', 'variant-groups/g1', body);
      expect(response.statusCode).toBe(400);
      await compare(response, await legacy.updateGroup('g1', body));
      expect(await snapshot()).toEqual(before);
    });
    it('updates complete ASIN fields and parent time without changing unrelated children', async () => {
      await group('g1');
      await asin('a1');
      await asin('a2');
      const before = await snapshot();
      const { parentId: _parent, ...body } = {
        ...asinBody,
        asin: ' new-code ',
        asinType: '2',
        name: 'Changed',
        brand: 'New own brand',
      };
      await compare(
        await request('PUT', 'asins/a1', body),
        await legacy.updateAsin('a1', body),
      );
      expect((await snapshot()).asins.find((row) => row.id === 'a2')).toEqual(
        before.asins.find((row) => row.id === 'a2'),
      );
      complete(
        (
          await f.http.inject({
            method: 'GET',
            url: '/api/v1/competitor/variant-groups/g1',
            headers,
          })
        ).json(),
        (await legacy.detail('g1')).body,
      );
    });
    it.each(['create', 'update'])(
      'rejects a %s country mismatch with the original source message',
      async (operation) => {
        await group('g1');
        await asin('a1');
        const before = await snapshot();
        const body = { ...asinBody, country: 'UK' };
        if (operation === 'create')
          await compare(
            await request('POST', 'asins', body),
            await legacy.createAsin(body),
          );
        else {
          const { parentId: _parent, ...update } = body;
          await compare(
            await request('PUT', 'asins/a1', update),
            await legacy.updateAsin('a1', update),
          );
        }
        expect(await snapshot()).toEqual(before);
      },
    );
    it('rejects an update duplicate under the real CI/accent/PADSPACE key', async () => {
      await group('g1');
      await asin('a1', 'g1', 'US', 'CAFÉ');
      await asin('a2');
      const before = await snapshot();
      const { parentId: _parent, ...body } = { ...asinBody, asin: 'cafe ' };
      await compare(
        await request('PUT', 'asins/a2', body),
        await legacy.updateAsin('a2', body),
      );
      expect(await snapshot()).toEqual(before);
    });
    it('moves an ASIN atomically and touches both parents with the complete source response', async () => {
      await group('g1');
      await group('g2');
      await asin('a1');
      await compare(
        await request('POST', 'asins/a1/move', { targetGroupId: 'g2' }),
        await legacy.moveAsin('a1', { targetGroupId: 'g2' }),
      );
      for (const id of ['g1', 'g2'])
        complete(
          (
            await f.http.inject({
              method: 'GET',
              url: `/api/v1/competitor/variant-groups/${id}`,
              headers,
            })
          ).json(),
          (await legacy.detail(id)).body,
        );
    });
    it('keeps same-group moves as true no-ops', async () => {
      await group('g1');
      await asin('a1');
      const before = await snapshot();
      await compare(
        await request('POST', 'asins/a1/move', { targetGroupId: 'g1' }),
        await legacy.moveAsin('a1', { targetGroupId: 'g1' }),
      );
      expect(await snapshot()).toEqual(before);
    });
    it('rejects cross-country moves without changing either group', async () => {
      await group('g1');
      await group('g2', 'UK');
      await asin('a1');
      const before = await snapshot();
      await compare(
        await request('POST', 'asins/a1/move', { targetGroupId: 'g2' }),
        await legacy.moveAsin('a1', { targetGroupId: 'g2' }),
      );
      expect(await snapshot()).toEqual(before);
    });
    it('resolves equivalent IDs to the canonical foreign key and enforces real constraints', async () => {
      await group('Gróup ');
      const response = await request('POST', 'asins', {
        ...asinBody,
        parentId: 'GROUP',
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.variantGroupId).toBe('Gróup ');
      await expect(
        f.pools.competitorPool.query(
          "INSERT INTO competitor_asins(id,asin,country,brand,variant_group_id) VALUES('orphan','ORPHAN','US','Fixture','missing')",
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });
    it('serializes competing equivalent ASIN creation across different parents with one success', async () => {
      await group('g1');
      await group('g2');
      const results = await Promise.all([
        request('POST', 'asins', { ...asinBody, asin: 'CAFÉ', parentId: 'g1' }),
        request('POST', 'asins', { ...asinBody, asin: 'CAFE', parentId: 'g2' }),
      ]);
      expect(
        results.filter((result) => result.statusCode === 200),
      ).toHaveLength(1);
      expect([400, 409]).toContain(
        results.find((result) => result.statusCode !== 200)!.statusCode,
      );
      const current = await snapshot();
      expect(current.asins).toHaveLength(1);
      const winner = current.asins[0].variant_group_id;
      expect(
        current.groups.find((row) => row.id !== winner)?.update_time,
      ).toEqual(current.groups.find((row) => row.id !== winner)?.create_time);
    });
    it('rejects a parent change committed while waiting for the original parent lock', async () => {
      await group('g1');
      await group('g2');
      await asin('a1');
      const client = await f.pools.competitorPool.connect();
      let pending: Promise<Awaited<ReturnType<typeof request>>> | undefined;
      try {
        await client.query('BEGIN');
        await client.query(
          "SELECT id FROM competitor_variant_groups WHERE id='g1' FOR UPDATE",
        );
        const { parentId: _parent, ...body } = asinBody;
        pending = Promise.resolve(request('PUT', 'asins/a1', body));
        await blocked(client);
        await client.query(
          "UPDATE competitor_asins SET variant_group_id='g2' WHERE id='a1'",
        );
        await client.query('COMMIT');
        expect((await pending).statusCode).toBe(409);
        expect((await snapshot()).asins[0]).toMatchObject({
          variant_group_id: 'g2',
          asin: 'B0000000A1',
        });
      } finally {
        await client.query('ROLLBACK');
        client.release();
        await pending?.catch(() => {});
      }
    });
    it('observes current permission revocation after waiting on the primary administration lock', async () => {
      await group('g1');
      expect((await read()).statusCode).toBe(200);
      const client = await f.pools.primaryPool.connect();
      let pending: Promise<Awaited<ReturnType<typeof request>>> | undefined;
      try {
        await client.query('BEGIN');
        await client.query(
          'SELECT pg_advisory_xact_lock(1095977294,1380073795)',
        );
        pending = Promise.resolve(request('POST', 'asins', asinBody));
        await blocked(client);
        await client.query('DELETE FROM user_roles WHERE user_id=$1', [userId]);
        await client.query('COMMIT');
        expect((await pending).statusCode).toBe(403);
        expect((await snapshot()).asins).toHaveLength(0);
      } finally {
        await client.query('ROLLBACK');
        client.release();
        await pending?.catch(() => {});
      }
    });
    it.each(['user', 'session'])(
      'rejects current %s invalidation even with warm guard caches',
      async (kind) => {
        await group('g1');
        expect((await read()).statusCode).toBe(200);
        if (kind === 'user')
          await f.pools.primaryPool.query(
            'UPDATE users SET force_password_change=true WHERE id=$1',
            [userId],
          );
        else
          await f.pools.primaryPool.query(
            "UPDATE sessions SET status='REVOKED' WHERE id=$1",
            [sessionId],
          );
        expect([401, 403]).toContain(
          (await request('POST', 'asins', asinBody)).statusCode,
        );
        expect((await snapshot()).asins).toHaveLength(0);
      },
    );
    it('holds primary authorization while the competitor write waits and commits', async () => {
      await group('g1');
      expect((await read()).statusCode).toBe(200);
      const blocker = await f.pools.competitorPool.connect(),
        changer = await f.pools.primaryPool.connect();
      let pending: Promise<Awaited<ReturnType<typeof request>>> | undefined,
        changed: Promise<unknown> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          'LOCK TABLE competitor_variant_groups IN ACCESS EXCLUSIVE MODE',
        );
        pending = Promise.resolve(request('POST', 'asins', asinBody));
        await blocked(blocker);
        const pid = (await changer.query('SELECT pg_backend_pid() AS pid'))
          .rows[0].pid;
        changed = changer.query(
          'UPDATE users SET force_password_change=true WHERE id=$1',
          [userId],
        );
        await vi.waitFor(
          async () =>
            expect(
              (
                await f.pools.primaryPool.query(
                  'SELECT count(*)::int AS n FROM pg_locks WHERE pid=$1 AND NOT granted',
                  [pid],
                )
              ).rows[0].n,
            ).toBeGreaterThan(0),
          { timeout: 1000, interval: 10 },
        );
        await blocker.query('ROLLBACK');
        expect((await pending).statusCode).toBe(200);
        await changed;
        expect((await snapshot()).asins).toHaveLength(1);
        expect([401, 403]).toContain(
          (await request('POST', 'variant-groups', groupBody)).statusCode,
        );
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await changed?.catch(() => {});
        changer.release();
        await pending?.catch(() => {});
      }
    });
    it('rolls back the child insertion when the parent touch fails and redacts the database error', async () => {
      await group('g1');
      const before = await snapshot();
      await f.pools.competitorPool.query(
        "CREATE FUNCTION fail_competitor_touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-competitor-touch'; END $$; CREATE TRIGGER fail_competitor_touch AFTER UPDATE ON competitor_variant_groups FOR EACH ROW EXECUTE FUNCTION fail_competitor_touch()",
      );
      try {
        const response = await request('POST', 'asins', asinBody);
        expect(response.statusCode).toBe(500);
        expect(
          response.body + JSON.stringify(f.logger.error.mock.calls),
        ).not.toContain('private-competitor-touch');
        expect(await snapshot()).toEqual(before);
      } finally {
        await f.pools.competitorPool.query(
          'DROP TRIGGER fail_competitor_touch ON competitor_variant_groups; DROP FUNCTION fail_competitor_touch()',
        );
      }
      expect((await request('POST', 'asins', asinBody)).statusCode).toBe(200);
    });
    it('reports an uncertain outcome when a real committed write loses its acknowledgement', async () => {
      const pool = f.pools.competitorPool;
      const originalConnect = pool.connect.bind(pool);
      const spy = vi
        .spyOn(pool, 'connect')
        .mockImplementationOnce((async () => {
          const client = await originalConnect();
          const originalQuery = client.query;
          client.query = (async (...args: unknown[]) => {
            const result = await Reflect.apply(originalQuery, client, args);
            if (args[0] === 'COMMIT')
              throw new Error('private-lost-commit-ack');
            return result;
          }) as typeof client.query;
          return client;
        }) as typeof pool.connect);
      try {
        const response = await request('POST', 'variant-groups', {
          ...groupBody,
          name: 'Committed despite lost acknowledgement',
        });
        expect(response.statusCode).toBe(503);
        expect(response.body).toContain('刷新数据后再操作');
        expect(response.json().data).toBeUndefined();
        expect(
          response.body + JSON.stringify(f.logger.error.mock.calls),
        ).not.toContain('private-lost-commit-ack');
      } finally {
        spy.mockRestore();
      }
      expect((await snapshot()).groups).toEqual([
        expect.objectContaining({
          name: 'Committed despite lost acknowledgement',
        }),
      ]);
      expect((await read()).statusCode).toBe(200);
    });
    it('assigns mutation timestamps after the real parent lock wait', async () => {
      await group('g1');
      const blocker = await f.pools.competitorPool.connect();
      let pending: Promise<Awaited<ReturnType<typeof request>>> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          "SELECT id FROM competitor_variant_groups WHERE id='g1' FOR UPDATE",
        );
        pending = Promise.resolve(
          request('PUT', 'variant-groups/g1', groupBody),
        );
        await blocked(blocker);
        const releasedAt = Number(
          (
            await blocker.query(
              'SELECT (extract(epoch FROM clock_timestamp())*1000)::text AS value',
            )
          ).rows[0].value,
        );
        await blocker.query('ROLLBACK');
        const result = await pending;
        expect(result.statusCode).toBe(200);
        expect(
          Date.parse(result.json().data.updateTime),
        ).toBeGreaterThanOrEqual(Math.floor(releasedAt));
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await pending?.catch(() => {});
      }
    });
    it('rolls back parent and child metadata together when a later child update fails', async () => {
      await group('g1');
      await asin('a1');
      const before = await snapshot();
      await f.pools.competitorPool.query(
        "CREATE FUNCTION fail_competitor_child() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-competitor-child'; END $$; CREATE TRIGGER fail_competitor_child AFTER UPDATE ON competitor_asins FOR EACH ROW EXECUTE FUNCTION fail_competitor_child()",
      );
      try {
        expect(
          (
            await request('PUT', 'variant-groups/g1', {
              ...groupBody,
              country: 'UK',
            })
          ).statusCode,
        ).toBe(500);
        expect(await snapshot()).toEqual(before);
      } finally {
        await f.pools.competitorPool.query(
          'DROP TRIGGER fail_competitor_child ON competitor_asins; DROP FUNCTION fail_competitor_child()',
        );
      }
    });
    it('bounds real row-lock waits and recovers both host pools after timeout', async () => {
      await group('g1');
      const before = await snapshot(),
        blocker = await f.pools.competitorPool.connect();
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          "SELECT id FROM competitor_variant_groups WHERE id='g1' FOR UPDATE",
        );
        const start = Date.now(),
          response = await request('POST', 'asins', asinBody);
        expect(response.statusCode).toBe(500);
        expect(Date.now() - start).toBeLessThan(4500);
        expect(await snapshot()).toEqual(before);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      expect((await request('POST', 'asins', asinBody)).statusCode).toBe(200);
    });
    it('cancels a blocked write before commit and releases both borrowed transactions', async () => {
      await group('g1');
      const before = await snapshot(),
        blocker = await f.pools.competitorPool.connect();
      const repository = new PgCompetitorWriteRepository(
        f.pools.primaryPool,
        f.pools.competitorPool,
      );
      try {
        await blocker.query('BEGIN');
        await blocker.query(
          "SELECT id FROM competitor_variant_groups WHERE id='g1' FOR UPDATE",
        );
        const abort = new AbortController();
        const pending = repository.transaction(
          (unit) => unit.createAsin({ ...asinBody, asinType: '1', name: null }),
          abort.signal,
        );
        const rejected = expect(pending).rejects.toMatchObject({
          code: 'cancelled',
        });
        await blocked(blocker);
        abort.abort();
        await rejected;
        expect(await snapshot()).toEqual(before);
      } finally {
        repository.close();
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      expect((await request('POST', 'asins', asinBody)).statusCode).toBe(200);
    });
    it('rejects two pool objects connected to the same actual database before business SQL', async () => {
      const other = createPgPool(f.env.DATABASE_URL, {
        max: 1,
        connectionTimeoutMillis: 2000,
      });
      const repository = new PgCompetitorWriteRepository(
        f.pools.primaryPool,
        other,
      );
      try {
        await expect(
          repository.transaction((unit) => unit.createGroup(groupBody)),
        ).rejects.toMatchObject({ code: 'dependency' });
      } finally {
        repository.close();
        await other.end();
      }
      expect(
        (
          await f.pools.primaryPool.query(
            'SELECT * FROM competitor_variant_groups',
          )
        ).rows,
      ).toEqual([{ id: 'g1', name: 'wrong-primary-data' }]);
    });
    it('rejects a group response over 5000 children without committing even the parent edit', async () => {
      await group('g1');
      await f.pools.competitorPool.query(
        "INSERT INTO competitor_asins(id,asin,country,brand,variant_group_id) SELECT 'large-'||n,'B'||lpad(n::text,9,'0'),'US','Fixture','g1' FROM generate_series(1,5001)n",
      );
      const before = (await snapshot()).groups;
      expect(
        (
          await request('PUT', 'variant-groups/g1', {
            ...groupBody,
            name: 'Must not persist',
          })
        ).statusCode,
      ).toBe(413);
      expect((await snapshot()).groups).toEqual(before);
    });
    it('refuses disabled policy triggers before any mutations', async () => {
      await f.pools.competitorPool.query(
        'ALTER TABLE competitor_asins DISABLE TRIGGER trg_competitor_asins_update_time',
      );
      try {
        expect(
          (await request('POST', 'variant-groups', groupBody)).statusCode,
        ).toBe(503);
        for (const value of actionCases)
          expect(
            (
              await request(
                value.method,
                value.path,
                value.method === 'PUT' ? { enabled: true } : undefined,
              )
            ).statusCode,
          ).toBe(503);
        expect((await snapshot()).groups).toHaveLength(0);
      } finally {
        await f.pools.competitorPool.query(
          'ALTER TABLE competitor_asins ENABLE TRIGGER trg_competitor_asins_update_time',
        );
      }
    });
    it('refuses a missing unique policy index and resumes only after the actual upgrade', async () => {
      await f.pools.competitorPool.query(
        'DROP INDEX idx_neo_competitor_write_asin_country',
      );
      try {
        expect(
          (await request('POST', 'variant-groups', groupBody)).statusCode,
        ).toBe(503);
        expect((await snapshot()).groups).toHaveLength(0);
      } finally {
        await f.applyPolicy();
      }
      expect(
        (await request('POST', 'variant-groups', groupBody)).statusCode,
      ).toBe(200);
    });
    it('repeats the real upgrade/rollback, retains explicit/no-op timestamps and rolls back duplicate upgrades', async () => {
      await group('g1');
      await asin('a1', 'g1', 'US', 'CAFE');
      const original = await snapshot();
      await f.applyPolicy();
      await f.applyPolicy();
      expect(await snapshot()).toEqual(original);
      await f.pools.competitorPool.query(
        "UPDATE competitor_asins SET name=name WHERE id='a1'",
      );
      expect(await snapshot()).toEqual(original);
      const client = await f.pools.competitorPool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          "SELECT set_config('asin_monitor.competitor_timestamp_mode','explicit',true)",
        );
        await client.query(
          "UPDATE competitor_asins SET name='Changed',update_time=update_time WHERE id='a1'",
        );
        await client.query('COMMIT');
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
      expect((await snapshot()).asins[0].update_time).toEqual(
        original.asins[0].update_time,
      );
      await f.applyPolicy(true);
      await f.applyPolicy(true);
      expect(
        (await request('POST', 'variant-groups', groupBody)).statusCode,
      ).toBe(503);
      await f.pools.competitorPool.query(
        "INSERT INTO competitor_asins(id,asin,country,brand,variant_group_id) VALUES('dup','CAFÉ','US','Fixture','g1')",
      );
      const beforeFailure = await snapshot();
      await expect(f.applyPolicy()).rejects.toMatchObject({ code: '23505' });
      expect(await snapshot()).toEqual(beforeFailure);
      await f.pools.competitorPool.query(
        "DELETE FROM competitor_asins WHERE id='dup'",
      );
      await f.applyPolicy();
      await expect(
        f.pools.competitorPool.query(
          "INSERT INTO competitor_asins(id,asin,country,brand,variant_group_id) VALUES('dup','CAFÉ','US','Fixture','g1')",
        ),
      ).rejects.toMatchObject({ code: '23505' });
      const response = await request('POST', 'variant-groups', groupBody);
      expect(response.statusCode).toBe(200);
    });
  },
);
