import {
  competitorCreateAsinRequestSchema,
  competitorUpdateAsinRequestSchema,
} from '@asin-monitor/contracts';
import { describe, expect, it } from 'vitest';
import {
  CompetitorWriteInputError,
  parseCompetitorAsinCreate,
  parseCompetitorAsinMove,
  parseCompetitorAsinUpdate,
  parseCompetitorGroupDelete,
  parseCompetitorGroupUpdate,
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
  it.each(['', ' ', '\n\t\r'])(
    'preserves persisted group snapshot text %j while requiring valid new fields',
    (oldText) => {
      const expectedSource = {
        name: oldText,
        country: oldText,
        brand: oldText,
        updateTime: null,
      };
      expect(
        parseCompetitorGroupUpdate({
          name: 'Repaired',
          country: 'US',
          brand: 'Repaired brand',
          expectedSource,
        }).expectedSource,
      ).toEqual(expectedSource);
      expect(
        parseCompetitorGroupDelete({ expectedSource, expectedChildIds: [] })
          .expectedSource,
      ).toEqual(expectedSource);
      expect(() =>
        parseCompetitorGroupWrite({
          name: oldText,
          country: oldText,
          brand: oldText,
        }),
      ).toThrow(CompetitorWriteInputError);
    },
  );
  it('preserves optional parent snapshots without normalizing persisted fields', () => {
    const expectedParent = {
      name: '\n ',
      country: 'us ',
      brand: '',
      updateTime: '2020-01-01T00:00:00.000Z',
    };
    expect(
      parseCompetitorAsinCreate({ ...fields, expectedParent }),
    ).toMatchObject({ expectedParent, country: 'US' });
    expect(parseCompetitorAsinCreate(fields)).not.toHaveProperty(
      'expectedParent',
    );
  });
  it.each([
    { name: '\u0000', country: 'US', brand: 'Brand' },
    { name: '🔎'.repeat(256), country: 'US', brand: 'Brand' },
    { name: 'Group', country: '🔎'.repeat(11), brand: 'Brand' },
    { name: 'Group', country: 'US', brand: '🔎'.repeat(101) },
    null,
    {},
    { name: 'Group', country: 'US', brand: 'Brand', extra: true },
  ])('rejects invalid persisted group snapshot boundaries %j', (snapshot) => {
    expect(() =>
      parseCompetitorGroupDelete({ expectedSource: snapshot }),
    ).toThrow(CompetitorWriteInputError);
    expect(() =>
      parseCompetitorAsinCreate({ ...fields, expectedParent: snapshot }),
    ).toThrow(CompetitorWriteInputError);
  });
  it('accepts exact Unicode varchar limits and old ASIN snapshot whitespace', () => {
    const expectedParent = {
      name: '🔎'.repeat(255),
      country: '🔎'.repeat(10),
      brand: '🔎'.repeat(100),
    };
    expect(
      parseCompetitorAsinCreate({ ...fields, expectedParent }).expectedParent,
    ).toEqual(expectedParent);
    const { parentId: _parent, ...update } = fields;
    const expectedSource = {
      variantGroupId: 'Group-121',
      asin: '',
      name: '\n',
      country: '',
      brand: '\r',
      asinType: null,
      updateTime: null,
    };
    expect(
      parseCompetitorAsinUpdate({ ...update, expectedSource }).expectedSource,
    ).toEqual(expectedSource);
  });
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
      competitorCreateAsinRequestSchema.parse(input);
      expect(parseCompetitorAsinCreate(input).asinType).toBe(
        asinType ? String(asinType) : null,
      );
      const { parentId: _parentId, ...update } = input;
      competitorUpdateAsinRequestSchema.parse(update);
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
