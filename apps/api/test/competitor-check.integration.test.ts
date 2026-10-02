import {
  createVariantCheckOperation,
  PgCompetitorCheckRepository,
  type CompetitorCheckUnit,
} from '@asin-monitor/db';
import { parseCatalogVariantResult } from '@asin-monitor/sp-api';
import {
  CompetitorCheckPipeline,
  type CompetitorCheckContext,
} from '@asin-monitor/variant-check';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { competitorWriteApp } from './helpers/competitor-write-app';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'competitor immediate checks / two isolated PostgreSQL databases',
  () => {
    let fixture: Awaited<ReturnType<typeof competitorWriteApp>>;
    let repository: PgCompetitorCheckRepository;
    let userId: string;
    let sessionId: string;
    const guard = async () => undefined;
    const catalog = (asin: string) =>
      parseCatalogVariantResult(
        {
          asin,
          relationships: [
            {
              relationships: [
                { type: 'VARIATION', parentAsins: ['B000000099'] },
              ],
            },
          ],
        },
        asin,
      );
    const migration = (down = false) =>
      readFileSync(
        resolve(
          __dirname,
          `../../../packages/db/migrations/0014_competitor_check_receipts${
            down ? '.rollback' : ''
          }.sql`,
        ),
        'utf8',
      )
        .replaceAll(
          'public.competitor_variant_check_receipts',
          `"${fixture.competitorSchema}".competitor_variant_check_receipts`,
        )
        .replace(
          'SET LOCAL search_path TO pg_catalog, public;',
          `SET LOCAL search_path TO pg_catalog, "${fixture.competitorSchema}";`,
        );
    const applyMigration = async (down = false) => {
      const client = await fixture.pools.competitorPool.connect();
      try {
        await client.query(migration(down));
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };
    const authorize = async (unit: CompetitorCheckUnit) => {
      const user = await unit.lockOperator(userId);
      const session = await unit.lockSession(userId, sessionId);
      const permissions = await unit.operatorPermissionCodes(userId);
      if (
        !user ||
        !session ||
        session.status !== 'ACTIVE' ||
        !permissions.includes('asin:read')
      )
        throw new Error('Current primary authorization denied');
    };
    const context = (
      operation?: ReturnType<typeof createVariantCheckOperation>,
    ): CompetitorCheckContext => ({
      forceRefresh: true,
      operation,
      authorize,
      checkpoint: guard,
    });
    const operation = (kind: 'asin' | 'group') => {
      const now = new Date();
      const single = kind === 'asin';
      return createVariantCheckOperation(
        {
          taskId: randomUUID(),
          userId,
          taskCreatedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 3_600_000).toISOString(),
          taskType: 'variant-check',
          taskSubType: single
            ? 'competitor-asin-check'
            : 'competitor-variant-group-check',
          resultKind: single ? 'competitor-asin' : 'competitor-group',
          step: 'result',
        },
        single
          ? { asinId: 'a1', forceRefresh: true }
          : { groupId: 'g1', forceRefresh: true },
      );
    };
    const pipeline = () => {
      const checker = { check: vi.fn(async (asin: string) => catalog(asin)) };
      const service = new CompetitorCheckPipeline(
        repository,
        checker,
        {
          claim: async () => 'claim-1',
          write: async () => undefined,
          invalidate: async () => undefined,
          clearDeferred: async () => undefined,
        },
        { info() {}, warn() {} },
      );
      return { checker, service };
    };
    const history = async () =>
      (
        await fixture.pools.competitorPool.query(
          'SELECT asin_id,check_type,check_result,is_broken FROM competitor_monitor_history ORDER BY id',
        )
      ).rows;
    const receiptCount = async () =>
      Number(
        (
          await fixture.pools.competitorPool.query(
            'SELECT count(*)::int AS count FROM competitor_variant_check_receipts',
          )
        ).rows[0].count,
      );

    beforeAll(async () => {
      fixture = await competitorWriteApp();
      await applyMigration();
      await applyMigration();
      repository = new PgCompetitorCheckRepository(
        fixture.pools.primaryPool,
        fixture.pools.competitorPool,
      );
      userId = randomUUID();
      sessionId = randomUUID();
      fixture.userIds.add(userId);
      await fixture.pools.primaryPool.query(
        'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$2,$3,false)',
        [
          userId,
          `competitor-check-${userId.slice(0, 32)}`,
          'unused-fixture-hash',
        ],
      );
      await fixture.pools.primaryPool.query(
        "INSERT INTO user_roles(user_id,role_id) VALUES($1,'writer-71')",
        [userId],
      );
      await fixture.pools.primaryPool.query(
        "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,'2099-01-01 08:00:00')",
        [sessionId, userId],
      );
    });
    afterAll(async () => {
      repository?.close();
      await fixture?.close();
    });
    beforeEach(async () => {
      await fixture.pools.primaryPool.query(
        "INSERT INTO role_permissions(role_id,permission_id) SELECT 'writer-71',id FROM permissions WHERE code='asin:read' ON CONFLICT DO NOTHING",
      );
      await fixture.pools.competitorPool.query(
        'TRUNCATE competitor_variant_check_receipts,competitor_monitor_history,competitor_asins,competitor_variant_groups CASCADE',
      );
      await fixture.pools.competitorPool.query(
        "INSERT INTO competitor_variant_groups(id,name,country,brand,create_time,update_time) VALUES ('g1','Competitor group','US','Fixture','2026-01-01','2026-01-01'),('g2','Other group','US','Fixture','2026-01-01','2026-01-01')",
      );
      await fixture.pools.competitorPool.query(
        "INSERT INTO competitor_asins(id,asin,name,asin_type,country,brand,variant_group_id,create_time,update_time) VALUES ('a1','B000000001','First','MAIN_LINK','US','Fixture','g1','2026-01-01','2026-01-01'),('a2','B000000002','Second','VARIANT','US','Fixture','g1','2026-01-02','2026-01-02')",
      );
    });

    it('applies and rolls back migration 0014 twice inside the competitor schema only', async () => {
      expect(await receiptCount()).toBe(0);
      expect(
        (
          await fixture.pools.primaryPool.query(
            "SELECT to_regclass('competitor_variant_check_receipts') AS relation",
          )
        ).rows[0].relation,
      ).toBeNull();
      await applyMigration(true);
      await applyMigration(true);
      expect(
        (
          await fixture.pools.competitorPool.query(
            "SELECT to_regclass('competitor_variant_check_receipts') AS relation",
          )
        ).rows[0].relation,
      ).toBeNull();
      await applyMigration();
      await applyMigration();
      expect(await receiptCount()).toBe(0);
    });

    it('commits one single check with history and receipt, then replays it without a second write', async () => {
      const { checker, service } = pipeline();
      const op = operation('asin');
      try {
        const first = await service.checkSingle('a1', context(op));
        expect(first).toMatchObject({ isBroken: false });
        expect(await history()).toMatchObject([
          {
            asin_id: 'a1',
            check_type: 'ASIN',
            is_broken: false,
            check_result: { asin: 'B000000001', isBroken: false },
          },
        ]);
        expect(await receiptCount()).toBe(1);
        await fixture.pools.competitorPool.query(
          "DELETE FROM competitor_asins WHERE id='a1'",
        );
        expect(await service.checkSingle('a1', context(op))).toEqual(first);
        expect(checker.check).toHaveBeenCalledOnce();
        expect(await history()).toHaveLength(1);
        expect(await receiptCount()).toBe(1);
        expect(
          (
            await fixture.pools.primaryPool.query(
              "SELECT name FROM competitor_variant_groups WHERE id='g1'",
            )
          ).rows,
        ).toEqual([{ name: 'wrong-primary-data' }]);
      } finally {
        service.close();
      }
    });

    it('records recoverable group failure and every child in one competitor transaction', async () => {
      const { checker, service } = pipeline();
      const before = await repository.transaction((unit) =>
        unit.loadGroup('g1'),
      );
      checker.check.mockRejectedValueOnce(new Error('private upstream detail'));
      try {
        const result = await service.checkGroup(
          'g1',
          context(operation('group')),
        );
        expect(result).toMatchObject({
          isBroken: true,
          brokenByType: { SP_API_ERROR: 1 },
          details: {
            totalASINs: 2,
            brokenCount: 1,
            results: [
              {
                asin: 'B000000001',
                error: 'SP-API检查失败',
                errorType: 'SP_API_ERROR',
              },
              { asin: 'B000000002', hasVariants: true },
            ],
          },
        });
        const rows = await history();
        expect(rows).toHaveLength(3);
        expect(rows[0]).toMatchObject({
          check_type: 'GROUP',
          is_broken: true,
          check_result: {
            totalASINs: 2,
            brokenCount: 1,
            results: [
              {
                asin: 'B000000001',
                error: 'SP-API检查失败',
                errorType: 'SP_API_ERROR',
              },
              { asin: 'B000000002', hasVariants: true },
            ],
          },
        });
        expect(rows.slice(1)).toMatchObject([
          { asin_id: 'a1', check_type: 'ASIN', is_broken: true },
          { asin_id: 'a2', check_type: 'ASIN', is_broken: false },
        ]);
        const status = (
          await fixture.pools.competitorPool.query(
            'SELECT id,is_broken,variant_status,last_check_time FROM competitor_asins ORDER BY id',
          )
        ).rows;
        expect(status).toMatchObject([
          { id: 'a1', is_broken: true, variant_status: 'BROKEN' },
          { id: 'a2', is_broken: false, variant_status: 'NORMAL' },
        ]);
        expect(status.every((row) => row.last_check_time !== null)).toBe(true);
        const committed = await repository.transaction((unit) =>
          unit.loadGroup('g1'),
        );
        const children = (
          result as {
            groupSnapshot: {
              children: {
                id: string;
                updateTime: string | null;
                lastCheckTime: string | null;
                isBroken: number | null;
                variantStatus: string | null;
              }[];
            };
          }
        ).groupSnapshot.children;
        for (const child of children) {
          const previous = before.asins.find((row) => row.id === child.id)!;
          const persisted = committed.asins.find((row) => row.id === child.id)!;
          expect(child.updateTime).toBe(previous.updateTime?.toISOString());
          expect(persisted.updateTime!.getTime()).toBeGreaterThan(
            previous.updateTime!.getTime(),
          );
          expect(child.lastCheckTime).toBe(
            persisted.lastCheckTime?.toISOString(),
          );
          expect(child.isBroken).toBe(persisted.isBroken ? 1 : 0);
          expect(child.variantStatus).toBe(persisted.variantStatus);
        }
        expect(await receiptCount()).toBe(1);
        expect(JSON.stringify(rows)).not.toContain('private upstream detail');
      } finally {
        service.close();
      }
    });

    it('rolls back status and history when the receipt constraint rejects the write', async () => {
      const { service } = pipeline();
      await fixture.pools.competitorPool.query(
        "ALTER TABLE competitor_variant_check_receipts ADD CONSTRAINT fixture_receipt_failure CHECK (result_kind <> 'competitor-asin')",
      );
      try {
        await expect(
          service.checkSingle('a1', context(operation('asin'))),
        ).rejects.toBeInstanceOf(Error);
        expect(await history()).toEqual([]);
        expect(await receiptCount()).toBe(0);
        expect(
          (
            await fixture.pools.competitorPool.query(
              "SELECT last_check_time,is_broken FROM competitor_asins WHERE id='a1'",
            )
          ).rows,
        ).toEqual([{ last_check_time: null, is_broken: false }]);
      } finally {
        service.close();
        await fixture.pools.competitorPool.query(
          'ALTER TABLE competitor_variant_check_receipts DROP CONSTRAINT fixture_receipt_failure',
        );
      }
    });

    it('rejects changed group membership and current primary permission revocation', async () => {
      const snapshot = await repository.transaction((unit) =>
        unit.loadGroup('g1'),
      );
      await fixture.pools.competitorPool.query(
        "UPDATE competitor_asins SET variant_group_id='g2' WHERE id='a2'",
      );
      await expect(
        repository.transaction((unit) =>
          unit.commitGroup(
            snapshot,
            snapshot.asins.map((row) => ({
              asinId: row.id,
              kind: 'checked' as const,
              result: catalog(row.asin),
            })),
            guard,
          ),
        ),
      ).rejects.toMatchObject({ code: 'snapshot-changed' });
      expect(await history()).toEqual([]);
      await fixture.pools.primaryPool.query(
        "DELETE FROM role_permissions WHERE role_id='writer-71' AND permission_id=(SELECT id FROM permissions WHERE code='asin:read')",
      );
      const { checker, service } = pipeline();
      try {
        await expect(
          service.checkSingle('a1', context(operation('asin'))),
        ).rejects.toThrow('Current primary authorization denied');
        expect(checker.check).not.toHaveBeenCalled();
        expect(await history()).toEqual([]);
      } finally {
        service.close();
      }
    });
  },
);
