import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { CommittedGroupCheck } from '../src/domain/variant-check';
import { DrizzleVariantCheckUnit } from '../src/repositories/variant-check-repository';

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

    await unit.recordMonitorHistory(randomUUID(), committed, {
      isBroken: false,
    } as never);

    expect(values).toHaveBeenCalledTimes(1);
    expect(values.mock.calls[0][0]).toMatchObject([
      { checkType: 'GROUP', country: 'US' },
      { checkType: 'ASIN', country: 'US' },
    ]);
  });
});
