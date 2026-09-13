import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';
import {
  catalogNotFoundResult,
  parseCatalogRelationships,
  parseCatalogVariantResult,
} from '../src/catalog-variants';
import { SpApiError } from '../src/errors';
import { legacyService } from './catalog-legacy-fixture';

const nativeRequire = createRequire(__filename);
const legacyParser = nativeRequire(
  '../../../server/src/utils/variantParser.js',
);
const legacyNotFound = nativeRequire('../../../server/src/utils/spApiError.js');
const asin = 'B000000001',
  parent = 'B000000002',
  child = 'B000000003';
const relationships = (...rows: unknown[]) => [
  { marketplaceId: 'fixture', relationships: rows },
];
const shapes = [
  {},
  { relationships: [] },
  {
    relationships: relationships({
      type: 'VARIATION',
      parentAsins: [` ${parent.toLowerCase()} `],
    }),
  },
  {
    relationships: relationships({
      type: 'VARIATION',
      childAsins: [child, asin, child.toLowerCase()],
    }),
  },
  {
    relationships: relationships({
      type: 'VARIATION',
      parentAsins: [parent],
      childAsins: [child],
    }),
  },
  {
    relationships: relationships(null, {
      type: 'PACKAGE_HIERARCHY',
      childAsins: [child],
    }),
  },
  {
    relationships: relationships({ type: 'VARIATION' }),
    variations: [{ variationType: 'PARENT', asins: [child] }],
  },
  {
    relationships: relationships({ type: 'OTHER' }),
    variations: [{ variationType: 'CHILD', asins: [parent] }],
  },
  {
    variations: [
      null,
      {},
      { variationType: 'CHILD', asins: [parent, parent.toLowerCase(), asin] },
    ],
  },
  { variations: [{ variationType: 'PARENT', asins: [child, asin] }] },
  {
    variations: [{ variationType: 'UNKNOWN', asins: [child, null, false, ''] }],
  },
  {
    relationships: relationships({
      type: 'VARIATION',
      parentAsins: ['', parent],
    }),
  },
  { relationships: relationships({ type: 'VARIATION', parentAsins: [asin] }) },
  {
    relationships: [
      null,
      { relationships: [null] },
      ...relationships({ type: 'VARIATION', childAsins: [child] }),
    ],
  },
];

describe('Catalog relationship and result migration', () => {
  it.each(shapes)(
    'matches actual Legacy parent/child precedence, normalization and deduplication %#',
    (shape) => {
      const item = { asin, ...shape };
      expect(parseCatalogRelationships(item)).toEqual(
        legacyParser.parseVariantRelationships(item),
      );
      expect(parseCatalogRelationships(item, child)).toEqual(
        legacyParser.parseVariantRelationships(item, child),
      );
    },
  );
  it.each(
    shapes.flatMap((shape) => [
      {
        asin,
        ...shape,
        summaries: [
          {
            itemName: 'Fixture title',
            brand: 'Fixture brand',
            parentAsin: parent,
          },
        ],
      },
      {
        asin,
        ...shape,
        attributes: { item_name: [{ value: 'Attribute title' }] },
        summaries: [{ manufacturer: 'Fixture manufacturer' }],
      },
    ]),
  )(
    'matches the complete actual Legacy service result for both Catalog response wrappers %#',
    async (item) => {
      for (const response of [item, { items: [item] }]) {
        const fixture = legacyService(response);
        const old = await fixture.service.doCheckASINVariants(asin, 'US', true);
        expect(parseCatalogVariantResult(response, asin)).toEqual(old);
        expect(fixture.call).toHaveBeenCalledOnce();
        expect(fixture.setAsync).toHaveBeenCalledOnce();
      }
    },
  );
  it('preserves title fallback and ignores summary self-parent', async () => {
    const response = {
      asin,
      summaries: [
        {
          itemName: '',
          title: 'Second title',
          brand: '',
          manufacturer: 'Maker',
          parentAsin: asin.toLowerCase(),
        },
      ],
    };
    const old = await legacyService(response).service.doCheckASINVariants(
      asin,
      'US',
      true,
    );
    expect(parseCatalogVariantResult(response, asin)).toEqual(old);
    expect(parseCatalogVariantResult(response, asin)).toMatchObject({
      hasVariants: false,
      variantCount: 0,
      details: { parentAsin: null },
    });
  });
  it.each(['spapi', 'legacy_spapi'] as const)(
    'preserves the complete confirmed NOT_FOUND result for %s',
    (source) => {
      expect(catalogNotFoundResult(asin, 'US', source)).toEqual(
        legacyNotFound.buildASINNotFoundResult({ asin, country: 'US', source }),
      );
    },
  );
  it.each([
    null,
    [],
    {},
    { items: [] },
    { asin: parent },
    { asin, summaries: [{ itemName: 12 }] },
    { asin, summaries: [{ brand: {} }] },
  ])(
    'rejects invalid or different-product results instead of confirming no variants %#',
    (response) => {
      expect(() => parseCatalogVariantResult(response, asin)).toThrow(
        SpApiError,
      );
    },
  );
  it('bounds relationship traversal and rejects oversized JSON before making a business result', () => {
    expect(() =>
      parseCatalogRelationships({
        asin,
        relationships: relationships({
          type: 'VARIATION',
          childAsins: Array(10000).fill(child),
        }),
      }),
    ).toThrow('BODY_TOO_LARGE');
    expect(() =>
      parseCatalogVariantResult(
        { asin, title: 'x'.repeat(8 * 1024 * 1024) },
        asin,
      ),
    ).toThrow('BODY_TOO_LARGE');
  });
  it.each([undefined, () => undefined, 1n, NaN, Infinity])(
    'rejects non-JSON values %#',
    (value) => {
      expect(() => parseCatalogRelationships({ asin, value })).toThrow(
        'INVALID_RESPONSE',
      );
    },
  );
  it('rejects non-scalar ASINs safely and does not retain mutable transport objects', () => {
    expect(() =>
      parseCatalogRelationships({
        asin,
        variations: [{ asins: [{ toString: null }] }],
      }),
    ).toThrow('INVALID_RESPONSE');
    const item = {
      asin,
      relationships: relationships({ type: 'VARIATION', childAsins: [child] }),
    };
    const parsed = parseCatalogRelationships(item);
    (parsed.variationRelations[0].childAsins as string[]).push(parent);
    expect(legacyParser.parseVariantRelationships(item).variantASINs).toEqual([
      child,
    ]);
  });
});
