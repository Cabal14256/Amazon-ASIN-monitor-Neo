import { createPgPool, createVariantCheckOperation } from '@asin-monitor/db';
import {
  catalogNotFoundResult,
  parseCatalogVariantResult,
} from '@asin-monitor/sp-api';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  VariantCheckCommitUncertainError,
  VariantCheckPipeline,
} from '../src/pipeline';
import { PgVariantCheckRepository } from '../src/repository';
import type { VariantCheckRepositoryPort } from '../src/types';

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
        const receiptUpgrade = readFileSync(
          resolve(
            __dirname,
            '../../db/migrations/0006_variant_check_receipts.sql',
          ),
          'utf8',
        ).replaceAll('public', schema);
        await connection.query(receiptUpgrade);
        await connection.query(receiptUpgrade);
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
        'TRUNCATE variant_check_receipts, monitor_history, asins, variant_groups CASCADE',
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
    const operation = (params = { asinId: 'a1', forceRefresh: false }) => {
      const now = new Date();
      return createVariantCheckOperation(
        {
          taskId: randomUUID(),
          userId: 'fixture-owner',
          taskCreatedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 3600000).toISOString(),
          taskType: 'variant-check',
          taskSubType: 'asin-check',
          resultKind: 'asin',
          step: 'result',
        },
        params,
      );
    };
    const pipeline = (repo: VariantCheckRepositoryPort = repository) => {
      const check = vi.fn(async () => product());
      return {
        check,
        service: new VariantCheckPipeline(
          repo,
          { check },
          {
            invalidate: async () => undefined,
            clearDeferred: async () => undefined,
          },
          { info() {}, warn() {} },
        ),
      };
    };
    it('restores a committed single check after the actual PostgreSQL COMMIT acknowledgement is lost without duplicate history', async () => {
      let transactions = 0;
      const { service, check } = pipeline({
        transaction: async (action) => {
          const result = await repository.transaction(action);
          if (++transactions === 2)
            throw new Error('Fixture lost COMMIT acknowledgement');
          return result;
        },
      });
      const context = {
        authorize: guard,
        checkpoint: guard,
        operation: operation(),
      };
      try {
        await expect(service.checkSingle('a1', context)).rejects.toBeInstanceOf(
          VariantCheckCommitUncertainError,
        );
        expect(await history()).toHaveLength(1);
        await pool.query("DELETE FROM asins WHERE id='a1'");
        const result = await service.checkSingle('a1', context);
        expect(result).toMatchObject({ raw: { details: product() } });
        expect(check).toHaveBeenCalledOnce();
        expect(await history()).toHaveLength(1);
        expect(
          (await pool.query('SELECT * FROM variant_check_receipts')).rows,
        ).toHaveLength(1);
      } finally {
        service.close();
      }
    });
    it('serializes two actual transactions for the same operation and returns one immutable result', async () => {
      const { service, check } = pipeline();
      const context = {
        authorize: guard,
        checkpoint: guard,
        operation: operation(),
      };
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      let arrivals = 0;
      check.mockImplementation(async () => {
        if (++arrivals === 2) release();
        await pending;
        return product();
      });
      try {
        const results = await Promise.all([
          service.checkSingle('a1', context),
          service.checkSingle('a1', context),
        ]);
        expect(results[0]).toEqual(results[1]);
        expect(await history()).toHaveLength(1);
        expect(
          (await pool.query('SELECT * FROM variant_check_receipts')).rows,
        ).toHaveLength(1);
      } finally {
        release();
        service.close();
      }
    });
    it('rolls back status and history if a receipt cannot be stored in the same real transaction', async () => {
      const before = await load();
      const { service } = pipeline();
      await pool.query(
        "ALTER TABLE variant_check_receipts ADD CONSTRAINT fixture_receipt_failure CHECK (result_kind <> 'asin')",
      );
      try {
        await expect(
          service.checkSingle('a1', {
            authorize: guard,
            checkpoint: guard,
            operation: operation(),
          }),
        ).rejects.toBeInstanceOf(Error);
        expect((await load()).asin).toEqual(before.asin);
        expect(await history()).toEqual([]);
        expect(
          (await pool.query('SELECT * FROM variant_check_receipts')).rows,
        ).toEqual([]);
      } finally {
        service.close();
        await pool.query(
          'ALTER TABLE variant_check_receipts DROP CONSTRAINT fixture_receipt_failure',
        );
      }
    });
    it('rejects request replacement and expiry before returning an old receipt or running a new check', async () => {
      const { service, check } = pipeline();
      const op = operation();
      try {
        await service.checkSingle('a1', {
          authorize: guard,
          checkpoint: guard,
          operation: op,
        });
        const { operationKey: _key, requestHash: _hash, ...identity } = op;
        const changed = createVariantCheckOperation(identity, {
          asinId: 'a2',
          forceRefresh: false,
        });
        await expect(
          service.checkSingle('a2', {
            authorize: guard,
            checkpoint: guard,
            operation: changed,
          }),
        ).rejects.toMatchObject({ code: 'operation-mismatch' });
        const expired = createVariantCheckOperation(
          {
            ...identity,
            taskId: randomUUID(),
            taskCreatedAt: new Date(Date.now() - 7200000).toISOString(),
            expiresAt: new Date(Date.now() - 3600000).toISOString(),
          },
          { asinId: 'a1', forceRefresh: false },
        );
        await expect(
          service.checkSingle('a1', {
            authorize: guard,
            checkpoint: guard,
            operation: expired,
          }),
        ).rejects.toMatchObject({ code: 'operation-expired' });
        expect(check).toHaveBeenCalledOnce();
        expect(await history()).toHaveLength(1);
      } finally {
        service.close();
      }
    });
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
    it('persists the real hybrid result union without treating missing search items as confirmed NOT_FOUND', async () => {
      const before = await group();
      const result = await repository.transaction((unit) =>
        unit.commitGroup(
          before,
          [
            {
              asinId: 'a1',
              kind: 'checked',
              result: {
                asin: 'B000000001',
                hasVariants: false,
                variantCount: 0,
                errorType: 'NO_VARIANTS',
                details: {
                  asin: 'B000000001',
                  parentAsin: null,
                  source: 'batch_search',
                },
              },
            },
            {
              asinId: 'a2',
              kind: 'checked',
              result: {
                asin: 'B000000002',
                hasVariants: true,
                variantCount: 0,
                errorType: 'SP_API_ERROR',
                details: {
                  asin: 'B000000002',
                  parentAsin: 'B000000099',
                  source: 'batch_search_fallback',
                  error: '详细查询失败',
                  errorMessage: 'SP-API检查失败',
                },
              },
            },
          ],
          guard,
        ),
      );
      expect(result.asins.find((row) => row.id === 'a1')).toMatchObject({
        isBroken: true,
        variantStatus: 'BROKEN',
      });
      expect(result.asins.find((row) => row.id === 'a2')).toMatchObject({
        isBroken: false,
        variantStatus: 'NORMAL',
      });
      expect(result.observations).toMatchObject([
        { result: { errorType: 'NO_VARIANTS' } },
        { result: { hasVariants: true, errorType: 'SP_API_ERROR' } },
      ]);
      expect(await history()).toEqual([]);
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
    it('bounds expired receipt cleanup to 500 rows while retaining unexpired receipts and business data', async () => {
      await pool.query(`INSERT INTO variant_check_receipts(operation_key,request_hash,task_id,user_id,task_created_at,task_type,task_sub_type,step,result_kind,result,expires_at)
        SELECT lpad(to_hex(i),64,'0'),repeat('a',64),'fixture-task','fixture-owner','2026-01-01T00:00:00.000Z','variant-check','asin-check','result','asin','{}'::jsonb,
        (clock_timestamp() AT TIME ZONE 'Asia/Shanghai') + CASE WHEN i=502 THEN interval '1 hour' ELSE interval '-1 hour' END
        FROM generate_series(1,502) AS i`);
      expect(
        await repository.transaction((unit) => unit.purgeExpiredReceipts()),
      ).toBe(500);
      expect(
        (
          await pool.query(
            'SELECT count(*)::int AS count FROM variant_check_receipts',
          )
        ).rows[0].count,
      ).toBe(2);
      expect(
        await repository.transaction((unit) => unit.purgeExpiredReceipts()),
      ).toBe(1);
      expect(
        (
          await pool.query(
            'SELECT count(*)::int AS count FROM variant_check_receipts',
          )
        ).rows[0].count,
      ).toBe(1);
      expect((await group()).asins).toHaveLength(2);
    });
    it('applies the actual receipt rollback and upgrade without deleting ASINs or history', async () => {
      const { service } = pipeline();
      // The previous test deliberately disables 0004; each test normally resets
      // it in beforeEach, so this operation still exercises the real write policy.
      await service.checkSingle('a1', {
        authorize: guard,
        checkpoint: guard,
        operation: operation(),
      });
      service.close();
      const rollback = readFileSync(
        resolve(
          __dirname,
          '../../db/migrations/0006_variant_check_receipts.rollback.sql',
        ),
        'utf8',
      ).replaceAll('public', schema);
      const upgrade = readFileSync(
        resolve(
          __dirname,
          '../../db/migrations/0006_variant_check_receipts.sql',
        ),
        'utf8',
      ).replaceAll('public', schema);
      const connection = await pool.connect();
      try {
        await connection.query(rollback);
        expect(
          (
            await connection.query(
              `SELECT to_regclass('${schema}.variant_check_receipts') AS receipt`,
            )
          ).rows[0].receipt,
        ).toBeNull();
        expect(
          (
            await connection.query(
              'SELECT count(*)::int AS count FROM monitor_history',
            )
          ).rows[0].count,
        ).toBe(1);
        expect(
          (await connection.query('SELECT count(*)::int AS count FROM asins'))
            .rows[0].count,
        ).toBe(2);
      } finally {
        await connection.query(upgrade);
        await connection.query(upgrade);
        connection.release();
      }
      expect(
        (await pool.query('SELECT * FROM variant_check_receipts')).rows,
      ).toEqual([]);
    });
  },
);
