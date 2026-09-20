import {
  AsinQueryInputError,
  parseAsinGroupQuery,
} from '../asin/asin-query-values';

export { parseAsinGroupId as parseCompetitorGroupId } from '../asin/asin-query-values';
export function parseCompetitorGroupQuery(input: unknown) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length > 20 ||
    Object.values(input).some((value) => typeof value !== 'string')
  )
    throw new AsinQueryInputError();
  const value = input as Record<string, string>;
  // Competitor Legacy treats any nonempty status other than exact BROKEN as NORMAL.
  return parseAsinGroupQuery({
    ...value,
    variantStatus: value.variantStatus
      ? value.variantStatus === 'BROKEN'
        ? 'BROKEN'
        : 'NORMAL'
      : '',
  });
}
