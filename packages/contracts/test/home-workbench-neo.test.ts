import { describe, expect, it } from 'vitest';
import {
  homeWorkbenchDataSchema,
  homeWorkbenchQuerySchema,
} from '../src/domains/home-workbench-neo';
import { homeWorkbenchFixture } from './helpers/home-workbench';

describe('Neo-only Home workbench boundaries', () => {
  it('accepts complete original IDs/metadata and explicit unknown/no-observation days', () => {
    const data = homeWorkbenchFixture();
    data.list[0].id = '😺'.repeat(50);
    expect(homeWorkbenchDataSchema.parse(data)).toEqual(data);
    expect(
      homeWorkbenchDataSchema.parse(homeWorkbenchFixture(false)).list[0].trend,
    ).toBeNull();
  });
  it('parses bounded group/facet pages without trimming raw filter values', () => {
    expect(
      homeWorkbenchQuerySchema.parse({
        site: ' raw site ',
        brand: '😀'.repeat(100),
        country: 'us ',
        current: '2',
        pageSize: '20',
        facetCurrent: '51',
      }),
    ).toMatchObject({
      site: ' raw site ',
      country: 'us ',
      current: 2,
      pageSize: 20,
      facetCurrent: 51,
    });
    expect(homeWorkbenchQuerySchema.parse({})).toEqual({
      current: 1,
      pageSize: 10,
      facetCurrent: 1,
    });
  });
  it('preserves an explicit empty brand while retaining other input safeguards', () => {
    expect(homeWorkbenchQuerySchema.parse({ brand: '' })).toEqual({
      brand: '',
      current: 1,
      pageSize: 10,
      facetCurrent: 1,
    });
    for (const input of [
      { country: '' },
      { site: '' },
      { keyword: '' },
      { facetKeyword: '' },
      { brand: 'bad\u0000brand' },
      { brand: '\ud800' },
      { brand: 'x'.repeat(101) },
    ]) {
      expect(homeWorkbenchQuerySchema.safeParse(input).success).toBe(false);
    }
  });
  it.each([
    { pageSize: 21 },
    { current: 1001 },
    { current: 502, pageSize: 20 },
    { facetCurrent: 52 },
    { keyword: 'x'.repeat(101) },
    { site: 'bad\n' },
    { site: ['a'] },
    { country: null },
    { extra: true },
  ])('rejects invalid query %j', (input) => {
    expect(homeWorkbenchQuerySchema.safeParse(input).success).toBe(false);
  });
  it.each(['', 'x'.repeat(51), '\ud800', 'a\u0085'])(
    'rejects unsafe catalog key %j',
    (id) => {
      const data = homeWorkbenchFixture();
      data.list[0].id = id;
      expect(homeWorkbenchDataSchema.safeParse(data).success).toBe(false);
    },
  );
  it.each(['day', 'checks', 'unknown', 'grant', 'duplicate', 'facet'] as const)(
    'rejects incoherent %s data',
    (kind) => {
      const data = homeWorkbenchFixture();
      if (kind === 'day') data.days[0] = '2026-09-31';
      if (kind === 'checks') data.list[0].trend![0].brokenChecks = 4;
      if (kind === 'unknown') data.list[0].trend![0].unknownChecks = 3;
      if (kind === 'grant') data.trendsAuthorized = false;
      if (kind === 'duplicate') data.list.push(structuredClone(data.list[0]));
      if (kind === 'facet') data.facets.push(structuredClone(data.facets[0]));
      expect(homeWorkbenchDataSchema.safeParse(data).success).toBe(false);
    },
  );
  it('fails invalid extreme calendar input without throwing from the parser', () => {
    const data = homeWorkbenchFixture();
    data.generatedAt = '9999-12-31T23:59:59Z';
    expect(() => homeWorkbenchDataSchema.safeParse(data)).not.toThrow();
    expect(homeWorkbenchDataSchema.safeParse(data).success).toBe(false);
  });
});
