import { describe, expect, it } from 'vitest';
import {
  AsinQueryInputError,
  parseAsinGroupId,
  parseAsinGroupQuery,
} from '../src/asin/asin-query-values';

describe('ASIN query boundaries', () => {
  it('preserves empty/default pagination and blank filters', () => {
    expect(parseAsinGroupQuery({})).toEqual({ current: 1, pageSize: 10 });
    expect(
      parseAsinGroupQuery({
        current: '',
        pageSize: '',
        country: '',
        variantStatus: '',
      }),
    ).toEqual({
      current: 1,
      pageSize: 10,
      country: '',
      variantStatus: undefined,
    });
    expect(
      parseAsinGroupQuery({
        current: '2',
        pageSize: '100',
        keyword: ' a_% ',
        country: 'us',
        variantStatus: 'BROKEN',
      }),
    ).toMatchObject({
      current: 2,
      pageSize: 100,
      keyword: ' a_% ',
      country: 'us',
      variantStatus: 'BROKEN',
    });
  });
  it.each([
    null,
    [],
    { current: [] },
    { country: {} },
    { current: '0' },
    { pageSize: '101' },
    { pageSize: '-1' },
    { current: '1000002' },
    { keyword: 'x'.repeat(201) },
    { keyword: '\n' },
    { country: 'x'.repeat(11) },
    { variantStatus: 'unknown' },
    Object.fromEntries(Array.from({ length: 21 }, (_, n) => [n, 'x'])),
  ])('rejects invalid or unbounded query %j', (value) => {
    expect(() => parseAsinGroupQuery(value)).toThrow(AsinQueryInputError);
  });
  it.each(['', ' ', 'a'.repeat(51), 'bad\n', null, {}])(
    'rejects invalid group ID %j',
    (value) => {
      expect(() => parseAsinGroupId(value)).toThrow(AsinQueryInputError);
    },
  );
  it('keeps an allowed ID literal without trimming or SQL interpretation', () => {
    expect(parseAsinGroupId("a' OR 1=1--")).toBe("a' OR 1=1--");
  });
});
