import { createPgPool } from '@asin-monitor/db';
import {
  catalogNotFoundResult,
  parseCatalogVariantResult,
} from '@asin-monitor/sp-api';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PgVariantCheckRepository } from '../src/repository';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'Primary variant checks / actual PostgreSQL atomic writes',
  () => {
    let admin: Pool, pool: Pool, repository: PgVariantCheckRepository;
    const schema = `variant105_${randomUUID().replace(/-/g, '')}`;
    const guard = async () => undefined;
    const product = (index = 1, hasVariants = true) =>
      parseCatalogVariantResult(
        {
          asin: `B${String(index).padStart(9, '0')}`,
          relationships: hasVariants
            ? [
                {
                  relationships: [
                    { type: 'VARIATION', parentAsins: ['B000000099'] },
                  ],
                },
              ]
            : [],
        },
        `B${String(index).padStart(9, '0')}`,
      );
    beforeAll(async () => {
      if (!process.env.DATABASE_URL)
        throw new Error('Missing isolated fixture PostgreSQL URL');
      admin = createPgPool(process.env.DATABASE_URL, {
        max: 1,
        connectionTimeoutMillis: 1000,
      });
      admin.on('error', () => undefined);
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = createPgPool(process.env.DATABASE_URL, {
        max: 4,
        connectionTimeoutMillis: 1000,
        options: `-c search_path=${schema} -c timezone=Asia/Shanghai`,
      });
      pool.on('error', () => undefined);
      await pool.query(
        'CREATE TABLE variant_groups (LIKE public.variant_groups INCLUDING ALL)',
      );
      await pool.query(
        'CREATE TABLE asins (LIKE public.asins INCLUDING ALL EXCLUDING INDEXES)',
      );
      await pool.query(
        'ALTER TABLE asins ADD PRIMARY KEY(id), ADD CONSTRAINT fk_asins_variant_group FOREIGN KEY(variant_group_id) REFERENCES variant_groups(id) ON DELETE CASCADE',
      );
      await pool.query(
        'CREATE UNIQUE INDEX uq_asins_asin_country_ci ON asins(lower(asin),lower(country))',
      );
      await pool.query(
        'CREATE TABLE monitor_history (LIKE public.monitor_history INCLUDING ALL)',
      );
      const upgrade = readFileSync(
        resolve(
          __dirname,
          '../../db/migrations/0004_asin_timestamp_policy.sql',
        ),
        'utf8',
      ).replaceAll('public', schema);
      const connection = await pool.connect();
      try {
        await connection.query(upgrade);
      } finally {
        await connection.query(`SET search_path TO ${schema}`);
        connection.release();
      }
      repository = new PgVariantCheckRepository(pool);
    });
    afterAll(async () => {
      await pool?.end();
      if (admin) {
        if (!/^variant105_[a-f0-9]{32}$/.test(schema))
          throw new Error('Unsafe fixture schema');
        await admin.query(`DROP SCHEMA ${schema} CASCADE`);
        await admin.end();
      }
    });
    beforeEach(async () => {
      await pool.query(
        'ALTER TABLE asins ENABLE TRIGGER trg_asins_update_time',
      );
      await pool.query(
        'TRUNCATE monitor_history, asins, variant_groups CASCADE',
      );
      await pool.query(
        "INSERT INTO variant_groups(id,name,country,site,brand,create_time,update_time) VALUES ('g1','Group','US','amazon.com','Fixture','2026-01-01','2026-01-01'),('g2','Other','US','amazon.com','Fixture','2026-01-01','2026-01-01')",
      );
      await pool.query(
        "INSERT INTO asins(id,asin,name,country,site,brand,variant_group_id,create_time,update_time) VALUES ('a1','B000000001','First','US','amazon.com','Fixture','g1','2026-01-01','2026-01-01'),('a2','B000000002','Second','US','amazon.com','Fixture','g1','2026-01-02','2026-01-02')",
      );
    });
    const load = () => repository.transaction((unit) => unit.loadSingle('a1'));
    const group = () => repository.transaction((unit) => unit.loadGroup('g1'));
    const history = async () =>
      (await pool.query('SELECT * FROM monitor_history ORDER BY id')).rows;
    it('atomically writes the effective single-ASIN status, full history snapshots and consistent timestamps', async () => {
      const before = await load();
      const committed = await repository.transaction((unit) =>
        unit.commitSingle(before, product(1, false), guard),
      );
      const rows = await history();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        asin_id: 'a1',
        asin_code: 'B000000001',
        asin_name: 'First',
        variant_group_id: 'g1',
        variant_group_name: 'Group',
        site_snapshot: 'amazon.com',
        brand_snapshot: 'Fixture',
        country: 'US',
        check_type: 'ASIN',
        is_broken: true,
        check_result: {
          ...product(1, false),
          statusSource: 'AUTO',
          manualBrokenReason: '',
        },
      });
      expect(committed.asin.isBroken).toBe(true);
      expect(committed.asin.updateTime).toEqual(committed.asin.lastCheckTime);
      expect(committed.group.updateTime).toEqual(before.group.updateTime);
    });
    it('uses current manual fields and exclusions after the network phase without clearing them', async () => {
      const before = await load();
      await pool.query(
        "UPDATE variant_groups SET manual_broken=true,manual_broken_reason='Group reason' WHERE id='g1'",
      );
      await pool.query(
        "UPDATE asins SET manual_excluded_from_group=true,manual_excluded_reason='Excluded',manual_broken=true,manual_broken_reason='Own reason' WHERE id='a1'",
      );
      const committed = await repository.transaction((unit) =>
        unit.commitSingle(before, product(), guard),
      );
      expect(committed.asin).toMatchObject({
        isBroken: false,
        manualBroken: true,
        manualBrokenReason: 'Own reason',
        manualExcludedFromGroup: true,
        manualExcludedReason: 'Excluded',
      });
      expect((await history())[0]).toMatchObject({
        is_broken: true,
        check_result: {
          statusSource: 'MANUAL',
          manualBrokenReason: 'Own reason',
        },
      });
    });
    it('confirms NOT_FOUND in the child and parent in the same transaction, preserving the parent modification time', async () => {
      const before = await load();
      const committed = await repository.transaction((unit) =>
        unit.commitSingle(
          before,
          catalogNotFoundResult(before.asin.asin, 'US'),
          guard,
        ),
      );
      expect(committed.group.isBroken).toBe(true);
      expect(committed.group.lastCheckTime).toEqual(
        committed.asin.lastCheckTime,
      );
      expect(committed.group.updateTime).toEqual(before.group.updateTime);
      expect((await history())[0].check_result.errorType).toBe('NOT_FOUND');
    });
    it.each([
      "UPDATE asins SET variant_group_id='g2' WHERE id='a1'",
      "UPDATE asins SET asin='B000000003' WHERE id='a1'",
      "UPDATE asins SET country='UK' WHERE id='a1'",
      "UPDATE asins SET create_time='2026-02-01' WHERE id='a1'",
      "UPDATE asins SET last_check_time='2026-02-01' WHERE id='a1'",
    ])(
      'rejects a changed or superseded product snapshot before writing %#',
      async (mutation) => {
        const before = await load();
        await pool.query(mutation);
        await expect(
          repository.transaction((unit) =>
            unit.commitSingle(before, product(), guard),
          ),
        ).rejects.toMatchObject({ code: 'snapshot-changed' });
        expect(await history()).toEqual([]);
      },
    );
    it('rolls back state and history when the final task/session guard rejects commit', async () => {
      const before = await load();
      let checks = 0;
      await expect(
        repository.transaction((unit) =>
          unit.commitSingle(before, product(1, false), async () => {
            if (++checks === 2) throw new Error('fixture cancellation');
          }),
        ),
      ).rejects.toThrow('fixture cancellation');
      expect((await load()).asin).toEqual(before.asin);
      expect(await history()).toEqual([]);
    });
    it('rolls back every single-ASIN field if the history insertion fails', async () => {
      const before = await load();
      await pool.query(
        "ALTER TABLE monitor_history ADD CONSTRAINT fixture_history_failure CHECK (check_type <> 'ASIN')",
      );
      try {
        await expect(
          repository.transaction((unit) =>
            unit.commitSingle(before, product(1, false), guard),
          ),
        ).rejects.toBeInstanceOf(Error);
        expect((await load()).asin).toEqual(before.asin);
      } finally {
        await pool.query(
          'ALTER TABLE monitor_history DROP CONSTRAINT fixture_history_failure',
        );
      }
    });
    it('updates a complete group atomically, preserves deferred state/manual fields, and does not add monitor-runner history', async () => {
      await pool.query(
        "UPDATE asins SET is_broken=true,variant_status='BROKEN',manual_broken=true WHERE id='a2'",
      );
      const before = await group();
      const result = await repository.transaction((unit) =>
        unit.commitGroup(
          before,
          [
            { asinId: 'a1', kind: 'checked', result: product(1, false) },
            {
              asinId: 'a2',
              kind: 'deferred',
              error: 'ASIN检查失败，已加入延后队列',
            },
          ],
          guard,
        ),
      );
      expect(result.group.isBroken).toBe(true);
      expect(result.group.updateTime).toEqual(before.group.updateTime);
      expect(result.asins.find((row) => row.id === 'a2')).toMatchObject({
        isBroken: true,
        variantStatus: 'BROKEN',
        manualBroken: true,
      });
      expect(
        result.asins.every(
          (row) =>
            row.lastCheckTime?.getTime() ===
            result.group.lastCheckTime?.getTime(),
        ),
      ).toBe(true);
      expect(await history()).toEqual([]);
    });
    it('rejects group membership changes instead of applying a partially checked snapshot', async () => {
      const before = await group();
      await pool.query("UPDATE asins SET variant_group_id='g2' WHERE id='a2'");
      await expect(
        repository.transaction((unit) =>
          unit.commitGroup(
            before,
            [
              { asinId: 'a1', kind: 'checked', result: product() },
              { asinId: 'a2', kind: 'checked', result: product(2) },
            ],
            guard,
          ),
        ),
      ).rejects.toMatchObject({ code: 'snapshot-changed' });
      expect((await load()).asin.lastCheckTime).toBeNull();
    });
    it('keeps empty group checks read-only and requires the installed timestamp policy for writes', async () => {
      await pool.query("DELETE FROM asins WHERE variant_group_id='g1'");
      const before = await group();
      expect(
        await repository.transaction((unit) =>
          unit.commitGroup(before, [], guard),
        ),
      ).toEqual({ ...before, observations: [] });
      await pool.query(
        'ALTER TABLE asins DISABLE TRIGGER trg_asins_update_time',
      );
      await expect(
        repository.transaction((unit) => unit.commitGroup(before, [], guard)),
      ).rejects.toThrow('ASIN timestamp policy upgrade is required');
    });
  },
);
