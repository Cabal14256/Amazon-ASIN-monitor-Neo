import { describe, expect, it } from 'vitest';
import { countryStatusData } from './country-status-data';

const us = { country: 'US', total: 4, normal: 3, broken: '1' };
const zero = { country: 'UK', total: 0, normal: 0, broken: '0' };

describe('country status snapshot', () => {
  it('preserves actual categories, labels, order and zero rows without mutating the response', () => {
    const source = Object.freeze([Object.freeze(us), Object.freeze(zero)]);
    expect(countryStatusData(source, 'ALL')).toEqual({
      kind: 'ready',
      rows: [
        { ...us, label: '美国', broken: 1 },
        { ...zero, label: '英国', broken: 0 },
      ],
    });
    expect(source[0].broken).toBe('1');
  });
  it('filters by the exact selected country; a missing range is empty rather than invented zero rows', () => {
    expect(countryStatusData([us, zero], 'UK')).toEqual({
      kind: 'ready',
      rows: [{ ...zero, label: '英国', broken: 0 }],
    });
    expect(countryStatusData([us, zero], 'FR')).toEqual({ kind: 'empty' });
    expect(countryStatusData([], 'ALL')).toEqual({ kind: 'empty' });
  });
  it('accepts mathematically integral SQL aggregates and maximum safe counts', () => {
    expect(countryStatusData([{ ...us, broken: '1.0' }], 'ALL').kind).toBe(
      'ready',
    );
    expect(
      countryStatusData(
        [
          {
            ...us,
            total: Number.MAX_SAFE_INTEGER,
            normal: Number.MAX_SAFE_INTEGER,
            broken: 0,
          },
        ],
        'ALL',
      ).kind,
    ).toBe('ready');
  });
  it.each([
    { normal: 2 },
    { broken: 5 },
    { total: -1 },
    { normal: 0.5 },
    { broken: '0.5' },
    { broken: '9007199254740990.1' },
    { total: Number.MAX_SAFE_INTEGER + 1 },
    { broken: '9007199254740993' },
    { broken: NaN },
    { broken: Infinity },
    { broken: ' ' },
    { country: '' },
  ])(
    'reports an invalid snapshot instead of clipping or rounding %j',
    (change) => {
      expect(countryStatusData([{ ...us, ...change }], 'ALL').kind).toBe(
        'invalid',
      );
    },
  );
  it('rejects duplicate selected countries and leaves unrelated invalid countries out of a valid range', () => {
    expect(countryStatusData([us, us], 'ALL').kind).toBe('invalid');
    expect(countryStatusData([us, { ...zero, normal: -1 }], 'US').kind).toBe(
      'ready',
    );
  });
});
