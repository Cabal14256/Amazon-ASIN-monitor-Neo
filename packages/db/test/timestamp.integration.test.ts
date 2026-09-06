import { and, eq, gte, lt } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { PoolClient, PoolConfig } from 'pg';
import { describe, expect, it } from 'vitest';
import {
  createDb,
  createPgPool,
  createShanghaiTimestampTypeOverrides,
} from '../src/client';
import { AuthRepository } from '../src/repositories/auth-repository';
import { auditLogs } from '../src/schema';
import { competitorVariantGroups } from '../src/schema-competitor';

async function withFixture(
  url: string,
  operation: (client: PoolClient) => Promise<void>,
  types?: PoolConfig['types'],
) {
  const pool = createPgPool(url, {
    max: 1,
    connectionTimeoutMillis: 3000,
    types,
  });
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN');
    await operation(client);
  } finally {
    try {
      if (client) await client.query('ROLLBACK');
    } finally {
      client?.release();
      await pool.end();
    }
  }
}

// Isolated CI only. Each test owns one transaction and rolls back its fixtures.
describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'D8 actual PostgreSQL / Drizzle interoperability',
  () => {
    it('reads native SQL audit time, writes Beijing wall time and filters by instants', async () => {
      await withFixture(
        process.env.DATABASE_URL!,
        async (client) => {
          // Parameter encoding must not depend on the session timezone either.
          await client.query("SET LOCAL TIME ZONE 'UTC'");
          const { rows: inserted } = await client.query<{ id: string }>(
            "INSERT INTO audit_logs (action, resource_id, create_time) VALUES ('D8_FIXTURE', $1, timestamp '2026-09-06 12:30:15.123') RETURNING id",
            [randomUUID()],
          );
          const id = BigInt(inserted[0].id);
          const db = createDb(client);
          const [ormInserted] = await db
            .insert(auditLogs)
            .values({
              action: 'D8_INSERT_FIXTURE',
              createTime: new Date('2026-09-06T04:30:15.123Z'),
            })
            .returning({ id: auditLogs.id, createTime: auditLogs.createTime });
          expect(ormInserted.createTime?.toISOString()).toBe(
            '2026-09-06T04:30:15.123Z',
          );
          const { rows: nativeRead } = await client.query<{ wall: string }>(
            'SELECT create_time::text AS wall FROM audit_logs WHERE id = $1',
            [ormInserted.id],
          );
          expect(nativeRead[0].wall).toBe('2026-09-06 12:30:15.123');
          const [read] = await db
            .select()
            .from(auditLogs)
            .where(eq(auditLogs.id, id));
          expect(read.createTime?.toISOString()).toBe(
            '2026-09-06T04:30:15.123Z',
          );
          const updated = new Date('2026-12-31T20:15:00.789Z');
          await db
            .update(auditLogs)
            .set({ createTime: updated })
            .where(eq(auditLogs.id, id));
          const { rows: stored } = await client.query<{ wall: string }>(
            'SELECT create_time::text AS wall FROM audit_logs WHERE id = $1',
            [id],
          );
          expect(stored[0].wall).toBe('2027-01-01 04:15:00.789');
          const found = await db
            .select({ id: auditLogs.id })
            .from(auditLogs)
            .where(
              and(
                eq(auditLogs.id, id),
                gte(auditLogs.createTime, updated),
                lt(auditLogs.createTime, new Date(updated.getTime() + 1)),
              ),
            );
          expect(found).toEqual([{ id }]);
          await db
            .update(auditLogs)
            .set({ createTime: null })
            .where(eq(auditLogs.id, id));
          expect(
            (await db.select().from(auditLogs).where(eq(auditLogs.id, id)))[0]
              .createTime,
          ).toBeNull();
        },
        createShanghaiTimestampTypeOverrides(),
      );
    });

    it('uses the same encoding in the competitor database under a non-Beijing session timezone', async () => {
      await withFixture(
        process.env.COMPETITOR_DATABASE_URL!,
        async (client) => {
          await client.query("SET LOCAL TIME ZONE 'America/New_York'");
          const id = randomUUID();
          await client.query(
            "INSERT INTO competitor_variant_groups (id, name, country, brand, last_check_time) VALUES ($1, 'D8 fixture', 'US', 'fixture', timestamp '2026-09-06 00:30:00')",
            [id],
          );
          const db = createDb(client);
          const [read] = await db
            .select()
            .from(competitorVariantGroups)
            .where(eq(competitorVariantGroups.id, id));
          expect(read.lastCheckTime?.toISOString()).toBe(
            '2026-09-05T16:30:00.000Z',
          );
          await db
            .update(competitorVariantGroups)
            .set({ lastCheckTime: new Date('2026-09-06T04:30:15.123Z') })
            .where(eq(competitorVariantGroups.id, id));
          const { rows } = await client.query<{ wall: string }>(
            'SELECT last_check_time::text AS wall FROM competitor_variant_groups WHERE id = $1',
            [id],
          );
          expect(rows[0].wall).toBe('2026-09-06 12:30:15.123');
        },
      );
    });

    it('does not extend the validity of a session imported as Beijing DATETIME', async () => {
      await withFixture(process.env.DATABASE_URL!, async (client) => {
        const userId = randomUUID();
        const sessionId = randomUUID();
        await client.query(
          "INSERT INTO users (id, username, password) VALUES ($1, $2, 'fixture-only-hash')",
          [userId, `d8-${userId}`],
        );
        await client.query(
          "INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $2, timestamp '2026-09-06 12:30:00')",
          [sessionId, userId],
        );
        const repository = new AuthRepository(createDb(client));
        const session = await repository.findSessionById(sessionId);
        expect(session?.expiresAt?.toISOString()).toBe(
          '2026-09-06T04:30:00.000Z',
        );
        expect(session?.expiresAt?.getTime()).toBeLessThan(
          new Date('2026-09-06T04:31:00Z').getTime(),
        );
      });
    });
  },
);
