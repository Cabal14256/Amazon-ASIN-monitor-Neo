import { describe, expect, it, vi } from 'vitest';
import { runOldCatalogRecovery } from './helpers/catalog-old-recovery';

describe('frozen pre-deploy catalog recovery evidence', () => {
  it.each(['asin', 'competitor'] as const)(
    'executes original %s closures without hiding their historical local-admission failure',
    async (domain) => {
      const read = vi.fn(async () => undefined);
      const actual = await runOldCatalogRecovery(
        'fixture-owner',
        domain,
        {
          phase: 'inspection',
          operationId: 'check-214',
          check: {
            requestId: 'check-214',
            submittedAt: 1000,
            target: { kind: 'group', id: 'g1', label: 'Fixture' },
            taskId: 'task-214',
          },
        },
        read,
      );
      expect(read).toHaveBeenCalledTimes(1);
      expect(actual.afterRecovery).toBeNull();
      expect(JSON.parse(actual.receipt!)).toMatchObject({ taskId: 'task-214' });
      expect(actual.admitted).toMatchObject({
        phase: 'refresh',
        createUncertain: true,
      });
    },
  );
});
