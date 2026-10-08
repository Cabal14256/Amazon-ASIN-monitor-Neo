import { describe, expect, it } from 'vitest';
import {
  batchDeleteVariantGroupsRequestSchema,
  isNeoBatchDeleteId,
  neoBatchDeleteTargetsSchema,
  neoBatchDeleteVariantGroupsRequestSchema,
} from '../src';

describe('Neo literal deletion keys and frozen Legacy request boundary', () => {
  it('preserves whitespace, case, accents and 50 astral codepoints exactly', () => {
    const groupIds = [
      ' Raw Ś ',
      'Raw Ś',
      'Case',
      'case',
      'café',
      'cafe',
      '   ',
      '😺'.repeat(50),
    ];
    const value = { groupIds, asinIds: [' Child Ś '], useAsync: true };
    expect(neoBatchDeleteVariantGroupsRequestSchema.parse(value)).toEqual(
      value,
    );
  });
  it('keeps the frozen v1 target-presence rule without transforming its strings', () => {
    expect(
      batchDeleteVariantGroupsRequestSchema.parse({ groupIds: [' Raw Ś '] }),
    ).toEqual({ groupIds: [' Raw Ś '] });
    expect(
      batchDeleteVariantGroupsRequestSchema.safeParse({ groupIds: ['   '] })
        .success,
    ).toBe(false);
    expect(neoBatchDeleteTargetsSchema.parse({ groupIds: ['   '] })).toEqual({
      groupIds: ['   '],
    });
  });
  it.each([
    '',
    'x'.repeat(51),
    '😺'.repeat(51),
    '\u0000',
    'a\n',
    '\u007f',
    '\u0085',
    '\ud800',
    '\udfff',
    'a\ud800b',
  ])('rejects unsafe literal key %j', (id) => {
    expect(isNeoBatchDeleteId(id)).toBe(false);
    expect(
      neoBatchDeleteTargetsSchema.safeParse({ groupIds: [id] }).success,
    ).toBe(false);
  });
  it.each([null, 1, {}, ['g']])('does not coerce a non-string key %j', (id) => {
    expect(isNeoBatchDeleteId(id)).toBe(false);
    expect(
      neoBatchDeleteTargetsSchema.safeParse({ asinIds: [id] }).success,
    ).toBe(false);
  });
  it('bounds raw entries before any deduplication and rejects extra request keys', () => {
    expect(
      neoBatchDeleteTargetsSchema.safeParse({ groupIds: Array(1000).fill('g') })
        .success,
    ).toBe(true);
    expect(
      neoBatchDeleteTargetsSchema.safeParse({
        groupIds: Array(1000).fill('g'),
        asinIds: ['a'],
      }).success,
    ).toBe(false);
    expect(
      neoBatchDeleteTargetsSchema.safeParse({ groupIds: [], asinIds: [] })
        .success,
    ).toBe(false);
    expect(
      neoBatchDeleteVariantGroupsRequestSchema.safeParse({
        groupIds: ['g'],
        extra: true,
      }).success,
    ).toBe(false);
  });
});
