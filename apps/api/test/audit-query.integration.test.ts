import {
  neoAuditLogDetailResultSchema,
  neoAuditLogListQuerySchema,
  neoAuditLogListResultSchema,
  neoAuditStatisticsQuerySchema,
} from '@asin-monitor/contracts';
import {
  AuditQueryDeadline,
  AuditQueryRepository,
  createPgPool,
} from '@asin-monitor/db';
import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditQueryApp } from './helpers/audit-query-app';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'Neo audit query PostgreSQL and HTTP integration',
  () => {
    const userId = `audit-${randomUUID()}`;
    const ids: string[] = [];
    let pool: ReturnType<typeof createPgPool>;
    let repository: AuditQueryRepository;
    let fixture: Awaited<ReturnType<typeof auditQueryApp>>;
    const range = { startTime: '2098-09-01', endTime: '2098-09-02' };
    beforeAll(async () => {
      pool = createPgPool(process.env.DATABASE_URL!, {
        max: 3,
        connectionTimeoutMillis: 2000,
      });
      repository = new AuditQueryRepository(pool);
      fixture = await auditQueryApp(repository);
      const rows = [
        [
          'UPDATE',
          'asin',
          { password: '***REDACTED***', fixture: true },
          '2098-09-01 08:00:00',
        ],
        ['update', null, ['fixture'], '2098-09-01 08:00:00'],
        ['DELETE', 'ASIN', 'fixture-string', '2098-09-01 07:59:59'],
        ['READ', 'asin', null, null],
      ];
      // The migration suite deliberately advances this identity past MAX_SAFE_INTEGER.
      // Own safe IDs isolate normal response checks without rewinding the shared sequence.
      const fixtureIdBase = randomInt(1_000_000_000, 2_000_000_000) * 10;
      for (const [action, resource, data, time] of rows) {
        const result = await pool.query(
          'INSERT INTO audit_logs (id, user_id, username, action, resource, resource_id, request_data, response_status, create_time) OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING id',
          [
            fixtureIdBase + ids.length,
            userId,
            'Audit-Fixture',
            action,
            resource,
            userId,
            JSON.stringify(data),
            200,
            time,
          ],
        );
        ids.push(String(result.rows[0].id));
      }
    });
    afterAll(async () => {
      if (fixture) await fixture.app.close();
      if (pool) {
        try {
          await pool.query('DELETE FROM audit_logs WHERE user_id = $1', [
            userId,
          ]);
        } finally {
          await pool.end();
        }
      }
    });
    it('lists camelCase records, keeps timestamp ties stable and NULL last, and paginates the full count', async () => {
      const response = await fixture.http.inject({
        method: 'GET',
        url: `/api/v1/audit-logs?userId=${userId}&pageSize=2`,
        headers: fixture.headers,
      });
      expect(response.statusCode).toBe(200);
      const parsed = neoAuditLogListResultSchema.parse(response.json());
      expect(parsed.data).toMatchObject({ total: 4, current: 1, pageSize: 2 });
      expect(parsed.data!.list.map((row) => row.id)).toEqual([
        Number(ids[1]),
        Number(ids[0]),
      ]);
      expect(parsed.data!.list[0]).toMatchObject({
        createTime: '2098-09-01T00:00:00.000Z',
        requestData: ['fixture'],
      });
      expect(parsed.data!.list[0]).not.toHaveProperty('create_time');
      const second = await repository.list(
        neoAuditLogListQuerySchema.parse({ userId, current: 2, pageSize: 2 }),
      );
      expect(second.list.map((row) => row.id)).toEqual([
        Number(ids[2]),
        Number(ids[3]),
      ]);
      expect(second.list[0].requestData).toBe('fixture-string');
      expect(second.list[1]).not.toHaveProperty('createTime');
      expect(second.list[1].requestData).toBeNull();
      const empty = await repository.list(
        neoAuditLogListQuerySchema.parse({ userId, current: 3, pageSize: 2 }),
      );
      expect(empty).toMatchObject({ total: 4, list: [] });
    });
    it('uses inclusive Beijing/ISO instants, case-insensitive filters and Legacy username wildcards', async () => {
      const equal = await repository.list(
        neoAuditLogListQuerySchema.parse({
          userId: userId.toUpperCase(),
          username: 'aUdi%fixture',
          action: 'UpDaTe',
          startTime: '2098-09-01 08:00:00',
          endTime: '2098-09-01T00:00:00Z',
        }),
      );
      expect(equal.total).toBe(2);
      const resource = await repository.list(
        neoAuditLogListQuerySchema.parse({
          userId,
          resource: 'aSiN',
          resourceId: userId.toUpperCase(),
          ...range,
        }),
      );
      expect(resource.total).toBe(2);
      const midnight = await repository.list(
        neoAuditLogListQuerySchema.parse({ userId, endTime: '2098-09-01' }),
      );
      expect(midnight.total).toBe(0);
      const injected = await repository.list(
        neoAuditLogListQuerySchema.parse({ userId, username: "' OR 1=1 --" }),
      );
      expect(injected.total).toBe(0);
    });
    it('returns a typed detail and aggregates case variants and NULL resource values', async () => {
      const response = await fixture.http.inject({
        method: 'GET',
        url: `/api/v1/audit-logs/${ids[0]}`,
        headers: fixture.headers,
      });
      expect(response.statusCode).toBe(200);
      const detail = neoAuditLogDetailResultSchema.parse(response.json());
      expect(detail.data).toMatchObject({
        id: Number(ids[0]),
        userId,
        resource: 'asin',
        requestData: { password: '***REDACTED***', fixture: true },
      });
      const filters = neoAuditStatisticsQuerySchema.parse(range);
      expect(await repository.actions(filters)).toEqual([
        { action: 'UPDATE', count: 2 },
        { action: 'DELETE', count: 1 },
      ]);
      expect(await repository.resources(filters)).toEqual([
        { resource: 'ASIN', count: 2 },
        { resource: null, count: 1 },
      ]);
      for (const kind of ['actions', 'resources'] as const) {
        const stats = await fixture.http.inject({
          method: 'GET',
          url: `/api/v1/audit-logs/statistics/${kind}?startTime=2098-09-01&endTime=2098-09-02`,
          headers: fixture.headers,
        });
        expect(stats.statusCode).toBe(200);
        expect(stats.json().data).toEqual(await repository[kind](filters));
      }
    });
    it('fails explicitly for bigint IDs that cannot be represented without precision loss', async () => {
      const oversized = (
        BigInt(Number.MAX_SAFE_INTEGER) + BigInt(randomInt(2, 1000000))
      ).toString();
      await pool.query(
        'INSERT INTO audit_logs (id, user_id, action) OVERRIDING SYSTEM VALUE VALUES ($1,$2,$3)',
        [oversized, userId, 'OVERFLOW'],
      );
      try {
        await expect(
          repository.list(
            neoAuditLogListQuerySchema.parse({ userId, action: 'OVERFLOW' }),
          ),
        ).rejects.toMatchObject({ reason: 'invalid-result' });
      } finally {
        await pool.query(
          'DELETE FROM audit_logs WHERE id = $1 AND user_id = $2',
          [oversized, userId],
        );
      }
    });
    it('uses a repeatable read snapshot, prohibits writes, cancels real slow SQL, and restores pool settings', async () => {
      const read = new AuditQueryDeadline(pool);
      await read.run(async (db) => {
        const before = await db.execute(
          'SELECT count(*)::integer AS count FROM audit_logs',
        );
        const added = await pool.query(
          'INSERT INTO audit_logs (user_id, action) VALUES ($1,$2) RETURNING id',
          [userId, 'SNAPSHOT'],
        );
        try {
          const after = await db.execute(
            'SELECT count(*)::integer AS count FROM audit_logs',
          );
          expect(after.rows[0]).toEqual(before.rows[0]);
        } finally {
          await pool.query(
            'DELETE FROM audit_logs WHERE id = $1 AND user_id = $2',
            [added.rows[0].id, userId],
          );
        }
      });
      await expect(
        read.run(async (db) => {
          await db.execute('UPDATE audit_logs SET action = action WHERE false');
        }),
      ).rejects.toMatchObject({ reason: 'unavailable' });
      await expect(
        read.run(async (db) => {
          await db.execute('SELECT pg_sleep(8)');
        }),
      ).rejects.toMatchObject({ reason: 'timeout' });
      const settings = await pool.query('SHOW statement_timeout');
      expect(settings.rows[0].statement_timeout).toBe('0');
      expect(await repository.detail(Number(ids[0]))).toMatchObject({ userId });
    }, 10000);
  },
);
