import { SpApiError } from './errors';
import type { Country, Query, Region } from './types';
export const REGION_SETTINGS = {
  US: {
    endpoint: 'https://sellingpartnerapi-na.amazon.com',
    awsRegion: 'us-east-1',
  },
  EU: {
    endpoint: 'https://sellingpartnerapi-eu.amazon.com',
    awsRegion: 'eu-west-1',
  },
} as const;
const marketplaces = {
  US: 'ATVPDKIKX0DER',
  UK: 'A1F83G8C2ARO7P',
  DE: 'A1PA6795UKMFR9',
  FR: 'A13V1IB3VIYZZH',
  IT: 'APJ6JRA9NG5V4',
  ES: 'A1RKKUPIHCS9HS',
} as const;
export function normalizeCountry(country: string): Country {
  const value = typeof country === 'string' ? country.trim().toUpperCase() : '';
  if (!Object.hasOwn(marketplaces, value))
    throw new SpApiError('INVALID_INPUT');
  return value as Country;
}
export function getRegionByCountry(country: string): Region {
  return normalizeCountry(country) === 'US' ? 'US' : 'EU';
}
export function getMarketplaceId(country: string): string {
  return marketplaces[normalizeCountry(country)];
}
export function encode(value: string): string {
  try {
    return encodeURIComponent(value).replace(
      /[!'()*]/g,
      (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  } catch {
    throw new SpApiError('INVALID_INPUT');
  }
}
export function buildAmazonUrl(
  country: string,
  path: string,
  query: Query = {},
): URL {
  if (
    typeof path !== 'string' ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    /[\\#\x00-\x20]/.test(path) ||
    path.length > 8192
  )
    throw new SpApiError('INVALID_INPUT');
  const endpoint = REGION_SETTINGS[
    getRegionByCountry(country)
  ].endpoint.replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(path, endpoint);
    // Reject malformed encodings before signing or quota classification.
    decodeURIComponent(url.pathname);
  } catch {
    throw new SpApiError('INVALID_INPUT');
  }
  if (url.origin !== endpoint || url.username || url.password)
    throw new SpApiError('INVALID_INPUT');
  // Preserve prebuilt query semantics: don't silently add a second set of params.
  if (!path.includes('?')) {
    const preferred = path.includes('/catalog/2022-04-01/')
      ? ['marketplaceIds', 'includedData']
      : [];
    const keys = [
      ...new Set([
        ...preferred.filter((key) => Object.hasOwn(query, key)),
        ...Object.keys(query),
      ]),
    ];
    const parts: string[] = [];
    for (const key of keys) {
      const value = query[key];
      const values = (Array.isArray(value) ? value : [value])
        .filter((item) => item !== null && item !== undefined && item !== '')
        .map((item) => String(item).trim());
      if (values.length)
        parts.push(`${encode(key)}=${encode(values.join(','))}`);
    }
    url.search = parts.join('&');
  }
  if (url.href.length > 16384) throw new SpApiError('INVALID_INPUT');
  return url;
}
export function identifyOperation(method: string, path: string): string {
  let route: string;
  try {
    route = decodeURIComponent(path.split('?')[0]);
  } catch {
    throw new SpApiError('INVALID_INPUT');
  }
  if (
    method.toUpperCase() === 'GET' &&
    /^\/catalog\/\d{4}-\d{2}-\d{2}\/items\/[A-Z0-9]{10}$/.test(route)
  )
    return 'getCatalogItem';
  if (
    ['GET', 'POST'].includes(method.toUpperCase()) &&
    /^\/catalog\/\d{4}-\d{2}-\d{2}\/items$/.test(route)
  )
    return 'searchCatalogItems';
  return 'default'; // Bounded operation cardinality; no ASIN/PII-derived labels.
}
