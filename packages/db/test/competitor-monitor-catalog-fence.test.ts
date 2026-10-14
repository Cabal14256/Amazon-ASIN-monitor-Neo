import type { CompetitorMonitorJob } from '@asin-monitor/contracts';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/client';
import { PgCompetitorMonitorRepository } from '../src/repositories/competitor-monitor-repository';
import { PgCompetitorTransactions } from '../src/repositories/competitor-transactions';

const job = {
  taskId: '00000000-0000-4000-8000-000000000225',
  userId: 'synthetic-owner',
  createdAt: '2026-10-07T00:00:00.000Z',
  expiresAt: '2026-10-08T00:00:00.000Z',
  taskType: 'competitor-monitor',
  taskSubType: 'competitor',
  countries: ['US'],
} as CompetitorMonitorJob;
afterEach(() => vi.restoreAllMocks());
describe('competitor monitor / mandatory mutation guard', () => {
  it.each(['groups', 'claim', 'complete'] as const)(
    'rejects unscoped %s even if a transport admits the business database',
    async (method) => {
      const execute = vi.fn();
      const db = { execute } as unknown as Db;
      // Only transport is synthetic: the actual repository method must enforce
      // its own mutation guard, rather than treating optional scope as enough.
      vi.spyOn(PgCompetitorTransactions.prototype, 'run').mockImplementation(
        async (_readOnly, action) =>
          action({
            authorization: {
              lockOperator: vi.fn(),
              lockSession: vi.fn(),
              operatorPermissionCodes: vi.fn(),
              competitorMonitorConfiguration: vi.fn(),
            },
            database: async () => db,
            ensureOpen: () => undefined,
          }),
      );
      const repository = new PgCompetitorMonitorRepository(
        {} as Pool,
        {} as Pool,
      );
      const authorize = async () => undefined;
      await expect(
        method === 'groups'
          ? repository.groups(job, authorize)
          : method === 'claim'
          ? repository.claimNotification(job, 'US', [], authorize)
          : repository.completeNotification(job, 'US', true, authorize),
      ).rejects.toThrow('CATALOG_OPERATION_MISSING');
      expect(execute).not.toHaveBeenCalled();
    },
  );
});
