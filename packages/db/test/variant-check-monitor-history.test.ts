import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import type { CommittedGroupCheck } from '../src/domain/variant-check';
import {
  catalogTransactionExecution,
  withCatalogOperationExemptExecution,
} from '../src/repositories/catalog-operation-execution';
import { DrizzleVariantCheckUnit } from '../src/repositories/variant-check-repository';

async function scheduledHistoryFixture<T>(
  db: unknown,
  action: () => Promise<T>,
) {
  return withCatalogOperationExemptExecution('scheduled-system', async () => {
    const execution = catalogTransactionExecution();
    await execution.begin();
    await execution.guard(db as never);
    try {
      return await action();
    } finally {
      await execution.settled('committed');
    }
  });
}

const legacy = {
  exports: {} as {
    getASINCheckOutcome(
      group: unknown,
      asin: unknown,
    ): { errorType: string | null; isDeferred: boolean };
  },
};
runInNewContext(
  readFileSync(
    resolve(
      __dirname,
      '../../../server/src/services/deferredASINRetryService.js',
    ),
    'utf8',
  ),
  {
    module: legacy,
    require(id: string) {
      if (id === './deferredASINPersistenceService') return {};
      if (id === '../utils/logger') return { info() {}, warn() {}, error() {} };
      throw new Error('Unexpected Legacy monitor history dependency');
    },
  },
);

describe('monitor history country normalization', () => {
  it('writes normalized countries for both group and ASIN rows', async () => {
    const values = vi.fn((rows: unknown[]) => ({
      returning: async () => rows.map((_, index) => ({ id: index + 1 })),
    }));
    const db = { insert: () => ({ values }) };
    const unit = new DrizzleVariantCheckUnit(db as never, () => undefined);
    const checkedAt = new Date('2026-09-27T00:00:00.000Z');
    const committed = {
      group: {
        id: 'group-1',
        name: 'Fixture group',
        country: 'us ',
        isCompetitor: false,
        lastCheckTime: checkedAt,
      },
      asins: [
        {
          id: 'asin-1',
          asin: 'B000000001',
          name: 'Fixture ASIN',
          country: 'de ',
          isBroken: false,
        },
      ],
      observations: [
        {
          asinId: 'asin-1',
          kind: 'checked',
          result: { hasVariants: true },
        },
      ],
    } as unknown as CommittedGroupCheck;

    await scheduledHistoryFixture(db, () =>
      unit.recordMonitorHistory(randomUUID(), committed, {
        isBroken: false,
      } as never),
    );

    expect(values).toHaveBeenCalledTimes(1);
    expect(values.mock.calls[0][0]).toMatchObject([
      { checkType: 'GROUP', country: 'US' },
      { checkType: 'ASIN', country: 'US' },
    ]);
  });

  it.each([
    {
      label: 'own manual marker',
      own: true,
      parent: false,
      excluded: false,
      automatic: false,
      deferred: false,
      source: 'MANUAL',
      errorType: 'MANUAL_MARKED',
    },
    {
      label: 'inherited manual marker',
      own: false,
      parent: true,
      excluded: false,
      automatic: false,
      deferred: false,
      source: 'MANUAL',
      errorType: 'MANUAL_MARKED',
    },
    {
      label: 'excluded inherited marker',
      own: false,
      parent: true,
      excluded: true,
      automatic: false,
      deferred: false,
      source: 'NORMAL',
      errorType: null,
    },
    {
      label: 'own marker despite exclusion',
      own: true,
      parent: true,
      excluded: true,
      automatic: false,
      deferred: false,
      source: 'MANUAL',
      errorType: 'MANUAL_MARKED',
    },
    {
      label: 'automatic error before manual fallback',
      own: true,
      parent: false,
      excluded: false,
      automatic: true,
      deferred: false,
      source: 'AUTO+MANUAL',
      errorType: 'NOT_FOUND',
    },
    {
      label: 'manual marker during deferred check',
      own: false,
      parent: true,
      excluded: false,
      automatic: false,
      deferred: true,
      source: 'MANUAL',
      errorType: 'MANUAL_MARKED',
    },
  ])('matches Legacy history classification for $label', async (scenario) => {
    const values = vi.fn((rows: unknown[]) => ({
      returning: async () => rows.map((_, index) => ({ id: index + 1 })),
    }));
    const db = { insert: () => ({ values }) };
    const unit = new DrizzleVariantCheckUnit(db as never, () => undefined);
    const asin = 'B000000001';
    const currentResult = {
      asin,
      hasVariants: !scenario.automatic,
      ...(scenario.automatic ? { errorType: 'NOT_FOUND' } : {}),
      isDeferred: scenario.deferred,
    };
    const committed = {
      group: {
        id: 'group-1',
        name: 'Fixture',
        country: 'US',
        isCompetitor: false,
        manualBroken: scenario.parent,
        lastCheckTime: new Date('2026-09-27T00:00:00.000Z'),
      },
      asins: [
        {
          id: 'asin-1',
          asin,
          isBroken: scenario.automatic,
          manualBroken: scenario.own,
          manualExcludedFromGroup: scenario.excluded,
        },
      ],
      observations: [
        {
          asinId: 'asin-1',
          kind: scenario.deferred ? 'deferred' : 'checked',
          result: currentResult,
        },
      ],
    } as unknown as CommittedGroupCheck;
    const oracle = legacy.exports.getASINCheckOutcome(
      { details: { results: [currentResult] } },
      { asin, statusSource: scenario.source },
    );
    expect(oracle.errorType).toBe(scenario.errorType);
    await scheduledHistoryFixture(db, () =>
      unit.recordMonitorHistory(randomUUID(), committed, {
        isBroken: scenario.source !== 'NORMAL',
      } as never),
    );
    const row = values.mock.calls[0][0][1] as {
      isBroken: boolean;
      checkResult: {
        errorType?: string;
        isDeferred: boolean;
        statusSource: string;
      };
    };
    expect(row.isBroken).toBe(scenario.source !== 'NORMAL');
    expect(row.checkResult.statusSource).toBe(scenario.source);
    expect(row.checkResult.errorType ?? null).toBe(oracle.errorType);
    expect(row.checkResult.isDeferred).toBe(oracle.isDeferred);
  });
});
