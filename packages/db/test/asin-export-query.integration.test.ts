import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { describe, expect, it } from 'vitest';
import { createPgPool } from '../src/client';
import {
  PgAsinExportQueryRepository,
  withAsinExportDatabaseTransaction,
} from '../src/repositories/asin-query-repository';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'ASIN export database deadline',
  () => {
    it('completes a query past the authentication deadline', async () => {
      const pool = createPgPool(process.env.DATABASE_URL!, {
        max: 1,
        connectionTimeoutMillis: 2000,
        statement_timeout: 1500,
      });
      try {
        const result = await withAsinExportDatabaseTransaction(pool, (db) =>
          db.execute(sql`SELECT pg_sleep(2.1) AS slept`),
        );
        expect(result.rows).toHaveLength(1);
      } finally {
        await pool.end();
      }
    }, 10_000);

    it('keeps role administration available while an export snapshot is open', async () => {
      const pool = createPgPool(process.env.DATABASE_URL!, {
        max: 2,
        connectionTimeoutMillis: 2000,
      });
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let release!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const snapshot = withAsinExportDatabaseTransaction(pool, async (db) => {
        await db.execute(sql`SELECT count(*) FROM variant_groups`);
        entered();
        await held;
        return 'export completed';
      });
      void snapshot.catch(() => undefined);
      let administration: PoolClient | undefined;
      try {
        await ready;
        administration = await pool.connect();
        await administration.query('BEGIN');
        await administration.query('SET LOCAL statement_timeout = 1500');
        // This is the exclusive lock used by real role/permission writes.
        await administration.query(
          'SELECT pg_advisory_xact_lock(1095977294,1380073795)',
        );
        await administration.query('COMMIT');
      } finally {
        if (administration) {
          await administration.query('ROLLBACK');
          administration.release();
        }
        release();
        await snapshot;
        await pool.end();
      }
    }, 10_000);

    it('continues group and child pages after inserts and deletes before the cursor', async () => {
      const pool = createPgPool(process.env.DATABASE_URL!, {
        max: 2,
        connectionTimeoutMillis: 2000,
        statement_timeout: 1500,
      });
      const repository = new PgAsinExportQueryRepository(pool);
      const prefix = `exp-${randomUUID().slice(0, 8)}`;
      const firstId = `${prefix}-first`;
      const secondId = `${prefix}-second`;
      const thirdId = `${prefix}-third`;
      const newerId = `${prefix}-newer`;
      const denseId = `${prefix}-dense`;
      const asinSeed = randomUUID().replaceAll('-', '').slice(0, 8);
      try {
        for (const [id, stamp] of [
          [firstId, '2026-09-27 04:00:00.123456'],
          [secondId, '2026-09-27 04:00:00.123455'],
          [thirdId, '2026-09-27 04:00:00.123454'],
        ])
          await pool.query(
            "INSERT INTO variant_groups(id,name,country,site,brand,create_time) VALUES($1,$1,'US','amazon.com','Fixture',$2)",
            [id, stamp],
          );
        const query = { keyword: prefix, current: 1, pageSize: 2 };
        const first = await repository.read((unit) =>
          unit.listExportGroups(query, undefined, true),
        );
        expect(first.total).toBe(3);
        expect(first.groups.map((group) => group.id)).toEqual([
          firstId,
          secondId,
        ]);
        await pool.query(
          "INSERT INTO variant_groups(id,name,country,site,brand,create_time) VALUES($1,$1,'US','amazon.com','Fixture','2026-09-27 05:00:00')",
          [newerId],
        );
        await pool.query('DELETE FROM variant_groups WHERE id=$1', [firstId]);
        const lastGroup = first.groups[1]!;
        const second = await repository.read((unit) =>
          unit.listExportGroups(
            query,
            {
              id: lastGroup.id,
              createTime: lastGroup.exportCursorTime!,
            },
            false,
          ),
        );
        expect(second.total).toBe(0);
        expect(second.groups.map((group) => group.id)).toEqual([thirdId]);

        await pool.query(
          "INSERT INTO variant_groups(id,name,country,site,brand) VALUES($1,$1,'ZZ','amazon.com','Fixture')",
          [denseId],
        );
        await pool.query(
          `INSERT INTO asins(id,asin,name,asin_type,country,site,brand,variant_group_id,create_time)
           SELECT $1 || '-' || lpad(n::text, 6, '0'),
             'Z' || $2 || lpad(n::text, 6, '0'), 'Dense', '1', 'ZZ', 'amazon.com', 'Fixture', $1,
             '2026-09-27 00:00:00.123456'
           FROM generate_series(1, 5001) AS n`,
          [denseId, asinSeed],
        );
        await pool.query('UPDATE asins SET manual_broken=true WHERE id=$1', [
          `${denseId}-005001`,
        ]);
        const denseGroup = await repository.read((unit) =>
          unit.listExportGroups(
            { keyword: denseId, current: 1, pageSize: 1 },
            undefined,
            true,
          ),
        );
        expect(denseGroup.groups[0]).toMatchObject({
          exportIsBroken: true,
          exportHasAutoBroken: false,
          exportHasManualBroken: true,
        });
        const children = await repository.read((unit) =>
          unit.listExportChildren(denseId),
        );
        expect(children).toHaveLength(5000);
        await pool.query(
          `INSERT INTO asins(id,asin,name,asin_type,country,site,brand,variant_group_id,create_time)
           VALUES($1,$2,'Inserted','1','ZZ','amazon.com','Fixture',$3,'2026-09-26 00:00:00')`,
          [`${prefix}-inserted`, `Z${asinSeed}999999`, denseId],
        );
        await pool.query('DELETE FROM asins WHERE id=$1', [children[0]!.id]);
        const lastChild = children[children.length - 1]!;
        const rest = await repository.read((unit) =>
          unit.listExportChildren(denseId, {
            id: lastChild.id,
            createTime: lastChild.exportCursorTime,
          }),
        );
        expect(rest.map((child) => child.id)).toEqual([`${denseId}-005001`]);
      } finally {
        await pool.query('DELETE FROM asins WHERE variant_group_id=$1', [
          denseId,
        ]);
        await pool.query('DELETE FROM variant_groups WHERE id LIKE $1', [
          `${prefix}%`,
        ]);
        await pool.end();
      }
    }, 30_000);

    it('keeps 5,002 ASINs in their original groups during moves in both directions', async () => {
      const pool = createPgPool(process.env.DATABASE_URL!, {
        max: 2,
        connectionTimeoutMillis: 2000,
      });
      const repository = new PgAsinExportQueryRepository(pool);
      const prefix = `snap-${randomUUID().slice(0, 8)}`;
      const early = `${prefix}-early`;
      const later = `${prefix}-later`;
      const movedForward = `${early}-000001`;
      const movedBackward = `${later}-only`;
      const seed = randomUUID().replaceAll('-', '').slice(0, 8);
      try {
        await pool.query(
          "INSERT INTO variant_groups(id,name,country,site,brand,create_time) VALUES($1,$1,'US','amazon.com','Fixture','2026-09-27 02:00:00'),($2,$2,'US','amazon.com','Fixture','2026-09-27 01:00:00')",
          [early, later],
        );
        await pool.query(
          `INSERT INTO asins(id,asin,country,site,brand,variant_group_id,create_time)
          SELECT $1 || '-' || lpad(n::text,6,'0'), 'Z' || $2 || lpad(n::text,6,'0'), 'US','amazon.com','Fixture',$1,'2026-09-27 00:00:00.123456'
          FROM generate_series(1,5001) AS n`,
          [early, seed],
        );
        await pool.query(
          "INSERT INTO asins(id,asin,country,site,brand,variant_group_id,manual_broken,create_time) VALUES($1,$2,'US','amazon.com','Fixture',$3,true,'2026-09-26 00:00:00')",
          [movedBackward, `Z${seed}999999`, later],
        );
        const captured = await repository.read(async (unit, ensureOpen) => {
          const query = { keyword: prefix, current: 1, pageSize: 1 };
          const first = await unit.listExportGroups(query, undefined, true);
          expect(first.total).toBe(2);
          expect(first.groups[0]).toMatchObject({
            id: early,
            exportHasManualBroken: false,
          });
          const children = await unit.listExportChildrenPage([early, later]);
          expect(children).toHaveLength(5000);
          // Independent connection commits the same membership mutation as
          // moveAsin while the snapshot connection stays open.
          await pool.query(
            'UPDATE asins SET variant_group_id=CASE id WHEN $1 THEN $3 ELSE $4 END WHERE id IN ($1,$2)',
            [movedForward, movedBackward, later, early],
          );
          const cursor = children[children.length - 1]!;
          const rest = await unit.listExportChildrenPage([early, later], {
            groupId: early,
            id: cursor.id,
            createTime: cursor.exportCursorTime,
          });
          expect(rest).toHaveLength(2);
          expect(rest.map((child) => child.variantGroupId)).toEqual([
            early,
            later,
          ]);
          const lastGroup = first.groups[0]!;
          const second = await unit.listExportGroups(
            query,
            { id: lastGroup.id, createTime: lastGroup.exportCursorTime! },
            false,
          );
          expect(second.groups[0]).toMatchObject({
            id: later,
            exportHasManualBroken: true,
          });
          ensureOpen();
          return [...children, ...rest];
        });
        expect(captured).toHaveLength(5002);
        expect(new Set(captured.map((child) => child.id)).size).toBe(5002);
        expect(
          captured.find((child) => child.id === movedForward)?.variantGroupId,
        ).toBe(early);
        expect(
          captured.find((child) => child.id === movedBackward)?.variantGroupId,
        ).toBe(later);
        // The live writes really committed; only the export snapshot stayed fixed.
        expect(
          (
            await pool.query(
              'SELECT id,variant_group_id FROM asins WHERE id IN ($1,$2) ORDER BY id',
              [movedForward, movedBackward],
            )
          ).rows,
        ).toEqual([
          { id: movedForward, variant_group_id: later },
          { id: movedBackward, variant_group_id: early },
        ]);
      } finally {
        await pool.query(
          'DELETE FROM asins WHERE variant_group_id IN ($1,$2)',
          [early, later],
        );
        await pool.query('DELETE FROM variant_groups WHERE id IN ($1,$2)', [
          early,
          later,
        ]);
        await pool.end();
      }
    }, 30_000);
  },
);
