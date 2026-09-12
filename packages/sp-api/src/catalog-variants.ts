import { SpApiError } from './errors';

export const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_COLLECTION_ITEMS = 10_000;
type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
const code = (value: unknown) => {
  if (
    value !== null &&
    value !== undefined &&
    !['string', 'number', 'boolean'].includes(typeof value)
  )
    throw new SpApiError('INVALID_RESPONSE');
  return String(value || '')
    .trim()
    .toUpperCase();
};

export interface CatalogRelationships {
  variantASINs: string[];
  parentASIN: string | null;
  isChild: boolean;
  isParent: boolean;
  variationRelations: JsonRecord[];
}

/** Decode only a bounded JSON snapshot, never retain a mutable transport payload. */
function snapshot(value: unknown): JsonRecord {
  try {
    const raw = JSON.stringify(value, (_key, child: unknown) => {
      if (
        ['function', 'symbol', 'bigint', 'undefined'].includes(typeof child) ||
        (typeof child === 'number' && !Number.isFinite(child))
      )
        throw new Error();
      return child;
    });
    if (!raw) throw new Error();
    if (Buffer.byteLength(raw) > MAX_CATALOG_BYTES)
      throw new SpApiError('BODY_TOO_LARGE');
    const parsed = record(JSON.parse(raw));
    if (!parsed) throw new Error();
    return parsed;
  } catch (error) {
    if (error instanceof SpApiError) throw error;
    throw new SpApiError('INVALID_RESPONSE');
  }
}

/** Legacy 2022 relationships take precedence over the older variations shape. */
export function parseCatalogRelationships(
  value: unknown,
  asin?: string,
): CatalogRelationships {
  const item = snapshot(value);
  const current = code(asin || item.asin);
  const variants = new Set<string>();
  const relations: JsonRecord[] = [];
  let parent: string | null = null,
    isChild = false,
    isParent = false,
    visited = 0;
  const entries = (value: unknown): unknown[] => {
    if (!Array.isArray(value)) return [];
    visited += value.length;
    if (visited > MAX_COLLECTION_ITEMS) throw new SpApiError('BODY_TOO_LARGE');
    return value;
  };
  const add = (value: unknown) => {
    const normalized = code(value);
    if (normalized && normalized !== current) variants.add(normalized);
  };
  for (const market of entries(item.relationships)) {
    for (const candidate of entries(record(market)?.relationships)) {
      const rel = record(candidate);
      if (!rel || rel.type !== 'VARIATION') continue;
      relations.push(rel);
      const parents = entries(rel.parentAsins),
        children = entries(rel.childAsins);
      if (parents.length) {
        isChild = true;
        if (!parent) parent = code(parents[0]);
        for (const value of parents) add(value);
      }
      if (children.length) {
        isParent = true;
        for (const value of children) add(value);
        if (!parent) parent = current;
      }
    }
  }
  if (!relations.length) {
    for (const candidate of entries(item.variations)) {
      const variation = record(candidate);
      const values = entries(variation?.asins);
      if (!variation || !values.length) continue;
      if (variation.variationType === 'CHILD') {
        isChild = true;
        if (!parent) parent = code(values[0]);
      } else if (variation.variationType === 'PARENT') {
        isParent = true;
        if (!parent) parent = current;
      }
      for (const value of values) add(value);
    }
  }
  return {
    variantASINs: [...variants],
    parentASIN: parent || null,
    isChild,
    isParent,
    variationRelations: relations,
  };
}

export interface CatalogVariantResult {
  hasVariants: boolean;
  variantCount: number;
  errorType?: 'NOT_FOUND';
  details: {
    asin: string;
    country?: string;
    title: string;
    brand: string | null;
    parentAsin: string | null;
    variations: { asin: string; title: string }[];
    relationships: JsonRecord[];
    notFound?: true;
  };
  meta: {
    source: 'spapi' | 'legacy_spapi' | 'html_scraper';
    apiVersion: string | null;
  };
}

/** Only the strict HTTP404 + Amazon NOT_FOUND classifier may call this builder. */
export function catalogNotFoundResult(
  asin: string,
  country: string,
  source: 'spapi' | 'legacy_spapi' = 'spapi',
): CatalogVariantResult {
  return {
    hasVariants: false,
    variantCount: 0,
    errorType: 'NOT_FOUND',
    details: {
      asin,
      country,
      title: '',
      brand: null,
      parentAsin: null,
      variations: [],
      relationships: [],
      notFound: true,
    },
    meta: { source, apiVersion: '2022-04-01' },
  };
}

export function parseCatalogVariantResult(
  value: unknown,
  requestedAsin: string,
): CatalogVariantResult {
  const response = snapshot(value);
  const item =
    Array.isArray(response.items) && response.items.length
      ? record(response.items[0])
      : response.asin
      ? response
      : undefined;
  if (!item || typeof item.asin !== 'string' || !item.asin.trim())
    throw new SpApiError('INVALID_RESPONSE');
  // A response for a different product must never overwrite this ASIN's status.
  if (code(item.asin) !== code(requestedAsin))
    throw new SpApiError('INVALID_RESPONSE');
  const relationships = parseCatalogRelationships(item);
  const summary = Array.isArray(item.summaries)
    ? record(item.summaries[0])
    : undefined;
  const attributeNames = record(item.attributes)?.item_name;
  const attributeName = Array.isArray(attributeNames)
    ? record(attributeNames[0])?.value
    : undefined;
  let summaryParent = summary?.parentAsin ? code(summary.parentAsin) : null;
  if (summaryParent === code(requestedAsin)) summaryParent = null;
  const title = summary?.itemName || summary?.title || attributeName || '';
  const brand = summary?.brand || summary?.manufacturer || null;
  if (
    typeof title !== 'string' ||
    (brand !== null && typeof brand !== 'string')
  )
    throw new SpApiError('INVALID_RESPONSE');
  return {
    hasVariants:
      relationships.variantASINs.length > 0 ||
      relationships.variationRelations.length > 0 ||
      !!summaryParent,
    variantCount:
      relationships.variantASINs.length ||
      relationships.variationRelations.length ||
      (summaryParent ? 1 : 0),
    details: {
      asin: item.asin,
      title,
      brand,
      parentAsin: relationships.parentASIN || summaryParent || null,
      variations: relationships.variantASINs.map((asin) => ({
        asin,
        title: '',
      })),
      relationships: relationships.variationRelations,
    },
    // Preserve Legacy's successful-API result shape, including the legacy-client fallback.
    meta: { source: 'spapi', apiVersion: '2022-04-01' },
  };
}

/** Bounded persisted-result codec. Cache/report consumers cannot treat an
 * arbitrary JSON object or another product's result as a successful check. */
export function decodeCatalogVariantResult(
  value: unknown,
  asin: string,
  country: string,
): CatalogVariantResult {
  const result = snapshot(value);
  const details = record(result.details),
    meta = record(result.meta);
  const only = (value: JsonRecord, keys: string[]) =>
    Object.keys(value).every((key) => keys.includes(key));
  const invalid = () => {
    throw new SpApiError('INVALID_RESPONSE');
  };
  if (
    !only(result, [
      'hasVariants',
      'variantCount',
      'errorType',
      'details',
      'meta',
    ]) ||
    typeof result.hasVariants !== 'boolean' ||
    !Number.isInteger(result.variantCount) ||
    (result.variantCount as number) < 0 ||
    (result.variantCount as number) > MAX_COLLECTION_ITEMS ||
    !details ||
    !meta
  )
    return invalid();
  if (
    !only(details, [
      'asin',
      'country',
      'title',
      'brand',
      'parentAsin',
      'variations',
      'relationships',
      'notFound',
    ]) ||
    typeof details.asin !== 'string' ||
    code(details.asin) !== code(asin) ||
    ('country' in details && details.country !== country) ||
    typeof details.title !== 'string' ||
    (details.brand !== null && typeof details.brand !== 'string') ||
    (details.parentAsin !== null && typeof details.parentAsin !== 'string') ||
    !Array.isArray(details.variations) ||
    details.variations.length > MAX_COLLECTION_ITEMS ||
    !Array.isArray(details.relationships) ||
    details.relationships.length > MAX_COLLECTION_ITEMS ||
    !only(meta, ['source', 'apiVersion']) ||
    !['spapi', 'legacy_spapi', 'html_scraper'].includes(
      meta.source as string,
    ) ||
    meta.apiVersion !== (meta.source === 'html_scraper' ? null : '2022-04-01')
  )
    return invalid();
  for (const candidate of details.variations) {
    const variation = record(candidate);
    if (
      !variation ||
      !only(variation, ['asin', 'title']) ||
      typeof variation.asin !== 'string' ||
      !variation.asin ||
      typeof variation.title !== 'string'
    )
      return invalid();
  }
  if (!details.relationships.every((item) => !!record(item))) return invalid();
  if ('errorType' in result || 'notFound' in details) {
    if (
      result.errorType !== 'NOT_FOUND' ||
      details.notFound !== true ||
      result.hasVariants !== false ||
      result.variantCount !== 0 ||
      details.country !== country ||
      details.title !== '' ||
      details.brand !== null ||
      details.parentAsin !== null ||
      details.variations.length ||
      details.relationships.length ||
      meta.source === 'html_scraper'
    )
      return invalid();
  }
  return result as unknown as CatalogVariantResult;
}
