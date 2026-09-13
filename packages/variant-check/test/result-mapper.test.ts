import {
  variantGroupCheckDataSchema,
  variantViewSchema,
} from '@asin-monitor/contracts';
import { catalogNotFoundResult } from '@asin-monitor/sp-api';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import {
  buildVariantViewFromResult,
  groupCheckResult,
  singleCheckResult,
} from '../src/result-mapper';
import { asin, checkedAt, group, product } from './fixtures';

const legacy = createRequire(__filename)(
  '../../../server/src/services/variantCheckResultMapper.js',
) as {
  buildVariantViewFromResult(value: unknown): unknown;
  mapVariantGroupResultWithVariantView(value: unknown): unknown;
};
const json = (value: unknown) => JSON.parse(JSON.stringify(value));

describe('Variant check full response / actual Legacy projection', () => {
  it.each([
    { name: 'null', value: null },
    { name: 'primitive', value: 'old result' },
    { name: 'empty object', value: {} },
    {
      name: 'direct result with duplicate siblings',
      value: {
        details: {
          asin: ' b000000001 ',
          title: 'Title',
          brand: 'Brand',
          variations: [
            { asin: 'B000000001' },
            { asin: 'b000000002' },
            { asin: 'B000000002' },
            { asin: '' },
          ],
        },
      },
    },
    {
      name: 'parentAsins relationship',
      value: {
        details: {
          asin: 'B000000001',
          relationships: [
            { parentAsins: [''] },
            { parentAsins: [' b000000099 '] },
          ],
        },
      },
    },
    {
      name: 'old PARENT relationship',
      value: {
        details: { relationships: [{ type: 'PARENT', asin: ' b000000099 ' }] },
      },
    },
    {
      name: 'alternate relationshipType',
      value: {
        details: {
          relationships: [
            { relationshipType: 'PARENT', parentAsin: 'b000000099' },
          ],
        },
      },
    },
    {
      name: 'explicit manual state',
      value: {
        isBroken: true,
        details: { asin: 'B000000001', variations: [{ asin: 'B000000002' }] },
      },
    },
    {
      name: 'full nested service wrapper',
      value: { isBroken: false, brokenASINs: [], details: product() },
    },
    {
      name: 'confirmed not found wrapper',
      value: {
        isBroken: true,
        details: catalogNotFoundResult('B000000001', 'US'),
      },
    },
  ])('matches the real Legacy mapper: $name', ({ value }) => {
    const result = buildVariantViewFromResult(value);
    expect(json(result)).toEqual(
      json(legacy.buildVariantViewFromResult(value)),
    );
    expect(result.raw).toBe(value);
    expect(variantViewSchema.safeParse(result).success).toBe(true);
  });

  it('retains the complete nested Catalog result and manual-only broken explanation', () => {
    const result = product();
    const output = singleCheckResult({
      asin: asin(1, {
        manualBroken: true,
        manualBrokenReason: 'Manual reason',
      }),
      group: group(),
      result,
    });
    expect(output).toEqual(
      legacy.buildVariantViewFromResult({
        isBroken: true,
        brokenASINs: [
          {
            asin: 'B000000001',
            errorType: 'MANUAL_MARKED',
            statusSource: 'MANUAL',
            manualBrokenReason: 'Manual reason',
          },
        ],
        details: result,
      }),
    );
    // This counterintuitive projection is the frozen API contract: the complete
    // Catalog details are one wrapper deeper and must remain under raw.
    expect(output).toMatchObject({
      asin: '',
      title: '',
      hasVariation: false,
      isBroken: true,
      raw: { details: result },
    });
  });

  it('uses current group inheritance and an ASIN exclusion independently from automatic status', () => {
    const parent = group({
      manualBroken: true,
      manualBrokenReason: 'Parent reason',
    });
    expect(
      singleCheckResult({ asin: asin(), group: parent, result: product() }),
    ).toMatchObject({
      isBroken: true,
      raw: {
        brokenASINs: [
          {
            errorType: 'MANUAL_MARKED',
            statusSource: 'MANUAL',
            manualBrokenReason: 'Parent reason',
          },
        ],
      },
    });
    expect(
      singleCheckResult({
        asin: asin(1, { manualExcludedFromGroup: true }),
        group: parent,
        result: product(),
      }).isBroken,
    ).toBe(false);
    expect(
      singleCheckResult({
        asin: asin(1, { manualExcludedFromGroup: true, isBroken: true }),
        group: parent,
        result: product(1, false),
      }),
    ).toMatchObject({
      isBroken: true,
      raw: {
        brokenASINs: [{ errorType: 'NO_VARIANTS', statusSource: 'AUTO' }],
      },
    });
  });

  it('keeps stored group state, effective deferred/manual state, counts and full per-item views distinct', () => {
    const output = groupCheckResult({
      group: group({ lastCheckTime: checkedAt }),
      asins: [
        asin(1, {
          isBroken: true,
          variantStatus: 'BROKEN',
          lastCheckTime: checkedAt,
        }),
        asin(2, {
          manualBroken: true,
          manualBrokenReason: 'Still manual',
          lastCheckTime: checkedAt,
        }),
      ],
      observations: [
        {
          asinId: 'a1',
          kind: 'deferred',
          error: 'ASIN检查失败，已加入延后队列',
        },
        { asinId: 'a2', kind: 'checked', result: product(2) },
      ],
    });
    expect(output).toMatchObject({
      isBroken: true,
      brokenByType: { SP_API_ERROR: 0, NOT_FOUND: 0, NO_VARIANTS: 0 },
      brokenASINs: [
        { asin: 'B000000001', statusSource: 'AUTO' },
        {
          asin: 'B000000002',
          errorType: 'MANUAL_MARKED',
          statusSource: 'MANUAL',
        },
      ],
      groupSnapshot: {
        is_broken: 0,
        variant_status: 'NORMAL',
        isBroken: 1,
        variantStatus: 'BROKEN',
        autoIsBroken: 1,
      },
      groupStatus: {
        is_broken: 1,
        statusSource: 'AUTO+MANUAL',
        last_check_time: checkedAt.toISOString(),
      },
    });
    const entries = output.details!.results!;
    expect(entries[0]).toMatchObject({ isBroken: false, isDeferred: true });
    expect(entries[1]).toMatchObject({ isBroken: false, details: product(2) });
    const withoutViews = {
      ...output,
      details: {
        results: entries.map(({ variantView: _view, ...rest }) => rest),
      },
    };
    expect(json(output)).toEqual(
      json(legacy.mapVariantGroupResultWithVariantView(withoutViews)),
    );
    expect(variantGroupCheckDataSchema.safeParse(output).success).toBe(true);
  });

  it('classifies confirmed NOT_FOUND, NO_VARIANTS and failed checks without counting manual-only state', () => {
    const output = groupCheckResult({
      group: group({
        isBroken: true,
        variantStatus: 'BROKEN',
        lastCheckTime: checkedAt,
      }),
      asins: [1, 2, 3].map((index) =>
        asin(index, { isBroken: true, lastCheckTime: checkedAt }),
      ),
      observations: [
        {
          asinId: 'a1',
          kind: 'checked',
          result: catalogNotFoundResult('B000000001', 'US'),
        },
        { asinId: 'a2', kind: 'checked', result: product(2, false) },
        { asinId: 'a3', kind: 'failed', error: 'SP-API检查失败' },
      ],
    });
    expect(output.brokenByType).toEqual({
      SP_API_ERROR: 1,
      NOT_FOUND: 1,
      NO_VARIANTS: 1,
    });
    expect(
      output.brokenASINs!.map((row) =>
        typeof row === 'string' ? row : row.errorType,
      ),
    ).toEqual(['NOT_FOUND', 'NO_VARIANTS', 'SP_API_ERROR']);
  });

  it('keeps empty-group read semantics with no fabricated check timestamp or status object', () => {
    const output = groupCheckResult({
      group: group(),
      asins: [],
      observations: [],
    });
    expect(output).toMatchObject({
      isBroken: true,
      groupSnapshot: { lastCheckTime: null, children: [] },
      details: { results: [] },
    });
    expect(output).not.toHaveProperty('groupStatus');
  });
});
