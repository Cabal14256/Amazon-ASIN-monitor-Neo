import { describe, expect, it } from 'vitest';
import {
  CompetitorWriteInputError,
  parseCompetitorAsinCreate,
  parseCompetitorAsinMove,
  parseCompetitorAsinUpdate,
  parseCompetitorGroupWrite,
  parseCompetitorWriteId,
} from '../src/competitor/competitor-write-values';

const fields = {
  asin: ' b000000121 ',
  country: ' us ',
  brand: 'Own brand',
  parentId: 'Group-121',
};
describe('competitor write input boundaries', () => {
  it('normalizes ASIN/country without importing primary-only metadata', () => {
    expect(parseCompetitorAsinCreate(fields)).toEqual({
      ...fields,
      asin: 'B000000121',
      country: 'US',
      name: null,
      asinType: null,
    });
    expect(
      parseCompetitorGroupWrite({
        name: ' Group ',
        country: ' uk ',
        brand: ' Brand ',
      }),
    ).toEqual({ name: ' Group ', country: 'UK', brand: ' Brand ' });
  });
  it.each([undefined, null, '', 0, false, 1, 2, '1', '2'])(
    'preserves Legacy controller type input %s',
    (asinType) => {
      const input = { ...fields, asinType };
      expect(parseCompetitorAsinCreate(input).asinType).toBe(
        asinType ? String(asinType) : null,
      );
      const { parentId: _parentId, ...update } = input;
      expect(parseCompetitorAsinUpdate(update).asinType).toBe(
        asinType ? String(asinType) : null,
      );
    },
  );
  it.each(['MAIN_LINK', 'SUB_REVIEW', ' 1 ', '3', 3, true, {}, []])(
    'rejects unsupported public type %j',
    (asinType) => {
      expect(() => parseCompetitorAsinCreate({ ...fields, asinType })).toThrow(
        CompetitorWriteInputError,
      );
    },
  );
  it.each([
    null,
    [],
    'body',
    {},
    { ...fields, site: 'primary-only' },
    { ...fields, manualBroken: true },
    { ...fields, country: ' ' },
    { ...fields, asin: ' ' },
    { ...fields, asin: 'A'.repeat(21) },
    { ...fields, country: 'ß'.repeat(6) },
    { ...fields, brand: 'B'.repeat(101) },
    { ...fields, name: '🔎'.repeat(501) },
    { ...fields, name: 'a\nb' },
    { ...fields, parentId: 'g'.repeat(51) },
  ])('rejects invalid storage or payload values %#', (input) => {
    expect(() => parseCompetitorAsinCreate(input)).toThrow(
      CompetitorWriteInputError,
    );
  });
  it('counts Unicode storage characters and retains exact IDs for CI/PADSPACE lookup', () => {
    const id = '🔎'.repeat(50);
    expect(parseCompetitorWriteId(id)).toBe(id);
    expect(
      parseCompetitorAsinCreate({
        ...fields,
        name: '🔎'.repeat(500),
        parentId: id,
      }).name,
    ).toHaveLength(1000);
    expect(parseCompetitorAsinMove({ targetGroupId: 'Gróup ' })).toEqual({
      targetGroupId: 'Gróup ',
    });
    expect(() =>
      parseCompetitorAsinMove({ targetGroupId: 'g', country: 'US' }),
    ).toThrow(CompetitorWriteInputError);
  });
});
