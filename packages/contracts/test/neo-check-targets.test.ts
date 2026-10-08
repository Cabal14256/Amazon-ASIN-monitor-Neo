import { describe, expect, it } from 'vitest';
import { batchCheckRequestSchema, variantCheckJobSchema } from '../src';

const identity = {
  taskId: '10000000-0000-4000-8000-000000000227',
  userId: 'fixture-owner',
  createdAt: '2026-10-07T00:00:00.000Z',
  expiresAt: '2026-10-14T00:00:00.000Z',
};
const kinds = [
  'asin-check',
  'variant-group-check',
  'competitor-asin-check',
  'competitor-variant-group-check',
  'variant-group',
] as const;
const job = (kind: (typeof kinds)[number], id: string) => ({
  ...identity,
  taskType: kind === 'variant-group' ? 'batch-check' : 'variant-check',
  taskSubType: kind,
  params: {
    ...(kind === 'variant-group'
      ? { groupIds: [id] }
      : kind.endsWith('asin-check')
      ? { asinId: id }
      : { groupId: id }),
    forceRefresh: true,
  },
});

describe.each(kinds)('Neo %s literal target boundary', (kind) => {
  it.each([' Leading Ś', 'Trailing Ś ', '   ', '😺'.repeat(50)])(
    'preserves a valid original database key %j',
    (id) =>
      expect(variantCheckJobSchema.parse(job(kind, id))).toEqual(job(kind, id)),
  );
  it.each([
    '',
    'x'.repeat(51),
    '😺'.repeat(51),
    'a\u0000b',
    'a\u001fb',
    '\u007f',
    '\u0085',
    '\u009f',
    '\ud800',
    'a\udfff',
  ])('rejects an impossible or unsafe database target %j', (id) => {
    expect(variantCheckJobSchema.safeParse(job(kind, id)).success).toBe(false);
  });
});

describe('frozen public contract and immutable private input', () => {
  it('does not narrow the frozen v1 batch-check request schema', () => {
    const value = { groupIds: ['x'.repeat(100), '   ', ' Raw Ś '] };
    expect(batchCheckRequestSchema.parse(value)).toEqual(value);
  });
  it('preserves exact duplicate targets and original order in private jobs', () => {
    const value = {
      ...job('variant-group', ' Raw Ś '),
      params: {
        groupIds: [' Raw Ś ', 'raw s', ' Raw Ś ', '😺'.repeat(50)],
        forceRefresh: true,
      },
    };
    expect(variantCheckJobSchema.parse(value)).toEqual(value);
    expect(
      variantCheckJobSchema.parse({ ...value, userId: 'u'.repeat(200) }),
    ).toEqual({
      ...value,
      userId: 'u'.repeat(200),
    });
  });
});
