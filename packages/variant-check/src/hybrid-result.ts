import {
  decodeCatalogVariantResult,
  SpApiError,
  type CatalogVariantResult,
} from '@asin-monitor/sp-api';

/** Legacy batch search intentionally emits a smaller result than getCatalogItem.
 * A missing search item is NO_VARIANTS, never a confirmed HTTP404 NOT_FOUND. */
export interface CatalogSearchVariantResult {
  asin: string;
  hasVariants: boolean;
  variantCount: 0;
  errorType: 'NO_VARIANTS' | 'SP_API_ERROR';
  details: {
    asin: string;
    parentAsin: string | null;
    source: 'batch_search' | 'batch_search_fallback';
    error?: '详细查询失败';
    errorMessage?: 'SP-API检查失败';
  };
}
export type GroupCatalogResult =
  | CatalogVariantResult
  | CatalogSearchVariantResult;

export function decodeGroupCatalogResult(
  value: unknown,
  asin: string,
  country: string,
): GroupCatalogResult {
  if (value && typeof value === 'object' && 'meta' in value)
    return decodeCatalogVariantResult(value, asin, country);
  const invalid = () => {
    throw new SpApiError('INVALID_RESPONSE');
  };
  let result: Record<string, unknown>;
  try {
    const raw = JSON.stringify(value);
    if (!raw || Buffer.byteLength(raw) > 1024) return invalid();
    result = JSON.parse(raw);
  } catch {
    return invalid();
  }
  if (!result || typeof result !== 'object' || Array.isArray(result))
    return invalid();
  const only = (record: object, keys: string[]) =>
    Object.keys(record).every((key) => keys.includes(key));
  const details = result.details as
    | CatalogSearchVariantResult['details']
    | undefined;
  if (
    !only(result, [
      'asin',
      'hasVariants',
      'variantCount',
      'errorType',
      'details',
    ]) ||
    result.asin !== asin ||
    typeof result.hasVariants !== 'boolean' ||
    result.variantCount !== 0 ||
    !details ||
    typeof details !== 'object' ||
    Array.isArray(details) ||
    details.asin !== asin ||
    !only(details, ['asin', 'parentAsin', 'source', 'error', 'errorMessage']) ||
    (details.parentAsin !== null &&
      (typeof details.parentAsin !== 'string' ||
        !/^[A-Z0-9]{10}$/.test(details.parentAsin)))
  )
    return invalid();
  if (details.source === 'batch_search') {
    if (
      result.hasVariants !== false ||
      result.errorType !== 'NO_VARIANTS' ||
      details.parentAsin !== null ||
      'error' in details ||
      'errorMessage' in details
    )
      return invalid();
  } else if (details.source === 'batch_search_fallback') {
    if (
      result.errorType !== 'SP_API_ERROR' ||
      details.error !== '详细查询失败' ||
      details.errorMessage !== 'SP-API检查失败'
    )
      return invalid();
  } else return invalid();
  return result as unknown as CatalogSearchVariantResult;
}
