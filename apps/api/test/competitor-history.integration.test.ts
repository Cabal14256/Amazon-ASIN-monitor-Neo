import {
  competitorMonitorHistoryDetailResultSchema,
  competitorMonitorHistoryListResultSchema,
} from '@asin-monitor/contracts';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { legacyCompetitorQueryFixture } from './helpers/competitor-query-legacy';
import { competitorWriteApp } from './helpers/competitor-write-app';

const canonical = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value), (key, item) =>
    key === 'check_result' && typeof item === 'string'
      ? JSON.parse(item)
      : item,
  );

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'competitor history / actual Legacy controller, MySQL, two PostgreSQL databases and HTTP',
  () => {
    let f: Awaited<ReturnType<typeof competitorWriteApp>>;
    let legacy: Awaited<ReturnType<typeof legacyCompetitorQueryFixture>>;
    let headers: { authorization: string };
    beforeAll(async () => {
      f = await competitorWriteApp({ primaryBusiness: true });
      legacy = await legacyCompetitorQueryFixture();
      await f.pools.primaryPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT 'writer-71',id FROM permissions WHERE code='monitor:read' ON CONFLICT DO NOTHING",
      );
      await f.pools.primaryPool.query(
        "CREATE TABLE competitor_monitor_history(id bigint PRIMARY KEY,check_result text); INSERT INTO competitor_monitor_history VALUES(999,'wrong-primary-data')",
      );
    });
    afterAll(async () => {
      try {
        await f?.close();
      } finally {
        await legacy?.close();
      }
    });
    beforeEach(async () => {
      await f.pools.primaryPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT 'writer-71',id FROM permissions WHERE code='monitor:read' ON CONFLICT DO NOTHING",
      );
      await f.pools.competitorPool.query(
        'DELETE FROM competitor_monitor_history',
      );
      await f.pools.competitorPool.query('DELETE FROM competitor_asins');
      await f.pools.competitorPool.query(
        'DELETE FROM competitor_variant_groups',
      );
      await legacy.query('DELETE FROM competitor_monitor_history');
      await legacy.query('DELETE FROM competitor_asins');
      await legacy.query('DELETE FROM competitor_variant_groups');
      const userId = randomUUID(),
        sessionId = randomUUID();
      f.userIds.add(userId);
      await f.pools.primaryPool.query(
        'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$2,$3,false)',
        [userId, `u131-${userId}`, 'unused-fixture-hash'],
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
      for (const [id, name] of [['g131', 'Current group']]) {
        await legacy.query(
          'INSERT INTO competitor_variant_groups(id,name,country,brand) VALUES(?,?,?,?)',
          [id, name, 'US', 'Brand'],
        );
        await f.pools.competitorPool.query(
          'INSERT INTO competitor_variant_groups(id,name,country,brand) VALUES($1,$2,$3,$4)',
          [id, name, 'US', 'Brand'],
        );
      }
      for (const [id, asin, asinType] of [
        ['a1', 'B000000001', 'main_link '],
        ['a2', 'B000000002', '2'],
      ]) {
        await legacy.query(
          'INSERT INTO competitor_asins(id,asin,name,asin_type,country,brand,variant_group_id) VALUES(?,?,?,?,?,?,?)',
          [id, asin, `Product ${id}`, asinType, 'US', 'Brand', 'g131'],
        );
        await f.pools.competitorPool.query(
          'INSERT INTO competitor_asins(id,asin,name,asin_type,country,brand,variant_group_id) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [id, asin, `Product ${id}`, asinType, 'US', 'Brand', 'g131'],
        );
      }
      const records = [
        [
          1,
          'g131',
          null,
          'a2',
          null,
          null,
          'ASIN',
          'US',
          1,
          '2026-09-13 08:00:00',
          JSON.stringify({ details: { parentAsin: 'b000000009' } }),
          1,
          '2026-09-13 08:30:00',
        ],
        [
          2,
          'deleted-group',
          'Retained group',
          'deleted-asin',
          'B000000003',
          'Retained product',
          'GROUP',
          'UK',
          0,
          '2026-09-13 09:00:00',
          JSON.stringify({ nested: [1, null, '快照'] }),
          0,
          '2026-09-13 09:30:00',
        ],
        [
          3,
          'g131',
          null,
          'a1',
          null,
          null,
          null,
          'US',
          null,
          '2026-09-13 10:00:00',
          null,
          null,
          null,
        ],
      ] as const;
      const columns =
        'id,variant_group_id,variant_group_name,asin_id,asin_code,asin_name,check_type,country,is_broken,check_time,check_result,notification_sent,create_time';
      for (const values of records) {
        await legacy.query(
          `INSERT INTO competitor_monitor_history(${columns}) VALUES(${values
            .map(() => '?')
            .join(',')})`,
          [...values],
        );
        const pgValues = values.map((value, index) =>
          [8, 11].includes(index) && value !== null ? Boolean(value) : value,
        );
        await f.pools.competitorPool.query(
          `INSERT INTO competitor_monitor_history(${columns}) OVERRIDING SYSTEM VALUE VALUES(${values
            .map((_, index) => '$' + (index + 1))
            .join(',')})`,
          pgValues,
        );
      }
    });
    const get = (path: string) =>
      f.http.inject({ method: 'GET', url: `/api/v1${path}`, headers });
    async function compareList(query: Record<string, string>) {
      const legacyResponse = await legacy.historyList(query);
      const url = new URLSearchParams(query).toString();
      const actual = await get(
        `/competitor/monitor-history${url ? '?' + url : ''}`,
      );
      expect(actual.statusCode).toBe(legacyResponse.statusCode);
      expect(actual.headers['cache-control']).toBe('no-store');
      competitorMonitorHistoryListResultSchema.parse(actual.json());
      expect(canonical(actual.json())).toEqual(canonical(legacyResponse.body));
    }
    it('matches all Legacy detail rows including snapshots, parent fallback, NULL and D8', async () => {
      for (const id of [1, 2, 3]) {
        const expected = await legacy.historyDetail(id);
        const actual = await get(`/competitor/monitor-history/${id}`);
        expect(actual.statusCode).toBe(200);
        competitorMonitorHistoryDetailResultSchema.parse(actual.json());
        expect(canonical(actual.json())).toEqual(canonical(expected.body));
      }
      expect(
        (
          await f.pools.primaryPool.query(
            'SELECT check_result FROM competitor_monitor_history WHERE id=999',
          )
        ).rows,
      ).toEqual([{ check_result: 'wrong-primary-data' }]);
    });
    const queries: Record<string, string>[] = [
      {},
      { variantGroupId: 'g131' },
      { asinId: 'a2' },
      { asin: 'b00000000%' },
      { country: 'UK' },
      { checkType: 'GROUP' },
      { isBroken: '0' },
      { startTime: '2026-09-13 09:00:00', endTime: '2026-09-13 10:00:00' },
      { current: '2', pageSize: '1' },
    ];
    it.each(queries)(
      'matches Legacy list filters and pagination %j',
      compareList,
    );
    it('rejects current primary permission revocation and invalid input', async () => {
      expect(
        (await get('/competitor/monitor-history?pageSize=101')).statusCode,
      ).toBe(400);
      await f.pools.primaryPool.query(
        "DELETE FROM role_permissions WHERE role_id='writer-71' AND permission_id=(SELECT id FROM permissions WHERE code='monitor:read')",
      );
      expect((await get('/competitor/monitor-history')).statusCode).toBe(403);
    });
  },
);
