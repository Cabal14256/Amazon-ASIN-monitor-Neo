import { describe, expect, it } from 'vitest';
import {
  duplicateCompetitorAsin,
  recoverableCompetitorBatchError,
} from '../src/repositories/competitor-write-errors';

describe('competitor batch error boundaries', () => {
  it.each(['22001', '22P02', '23505', '23503', '23514', 'P0001'])(
    'recovers only row-local SQLSTATE %s',
    (code) => {
      expect(recoverableCompetitorBatchError({ cause: { code } })).toBe(true);
    },
  );
  it.each([
    '40001',
    '40P01',
    '57014',
    '55P03',
    '08006',
    '53200',
    '57P01',
    'XX000',
    '',
    undefined,
  ])('aborts the transaction for SQLSTATE %s', (code) => {
    expect(recoverableCompetitorBatchError({ cause: { code } })).toBe(false);
  });
  it.each([
    'uk_competitor_asins_asin_country',
    'uq_competitor_asins_asin_country_ci',
    'idx_neo_competitor_write_asin_country',
  ])(
    'classifies only actual competitor identity constraints: %s',
    (constraint) => {
      expect(
        duplicateCompetitorAsin({ cause: { code: '23505', constraint } }),
      ).toBe(true);
      expect(duplicateCompetitorAsin({ code: '23503', constraint })).toBe(
        false,
      );
    },
  );
  it('does not label primary-key conflicts or arbitrary messages as business duplicates', () => {
    expect(
      duplicateCompetitorAsin({
        code: '23505',
        constraint: 'competitor_asins_pkey',
      }),
    ).toBe(false);
    expect(
      duplicateCompetitorAsin(
        new Error('23505 idx_neo_competitor_write_asin_country'),
      ),
    ).toBe(false);
    const cyclic = { cause: {} };
    cyclic.cause = cyclic;
    expect(recoverableCompetitorBatchError(cyclic)).toBe(false);
    expect(duplicateCompetitorAsin(cyclic)).toBe(false);
  });
});
