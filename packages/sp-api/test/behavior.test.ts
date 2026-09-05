import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { isCatalogItemNotFoundError, retryDelayMs } from '../src/errors';
import {
  buildAmazonUrl,
  getMarketplaceId,
  getRegionByCountry,
  identifyOperation,
} from '../src/request';

const legacyRequire = createRequire(__filename);
const legacy = legacyRequire('../../../server/src/utils/spApiError.js');
const asin = 'B000000001';
describe('migrated Legacy SP-API behavior', () => {
  it.each([
    { statusCode: 404, code: 'NOT_FOUND' },
    {
      statusCode: 404,
      responseData: JSON.stringify({ errors: [{ code: 'NOT_FOUND' }] }),
    },
    { response: { status: 404, data: { errors: [{ code: 'NOT_FOUND' }] } } },
    { statusCode: 404, responseData: Buffer.from('{"code":"NOT_FOUND"}') },
    { statusCode: 404, responseData: '<html>gateway not found</html>' },
    {
      statusCode: 404,
      errorCode: 'NOT_FOUND',
      responseData: '{"message":"NOT_FOUND"}',
    },
    { statusCode: 503, responseData: '{"code":"NOT_FOUND"}' },
    null,
  ])('only HTTP 404 plus Amazon NOT_FOUND is terminal (%j)', (error) => {
    expect(isCatalogItemNotFoundError(error)).toBe(
      legacy.isCatalogItemNotFoundError(error),
    );
  });
  it('maps six supported marketplaces to the preserved US/EU endpoints', () => {
    expect(getRegionByCountry('US')).toBe('US');
    for (const country of ['UK', 'DE', 'FR', 'IT', 'ES']) {
      expect(getRegionByCountry(country)).toBe('EU');
      expect(
        buildAmazonUrl(country, `/catalog/2022-04-01/items/${asin}`).host,
      ).toBe('sellingpartnerapi-eu.amazon.com');
    }
    expect(getMarketplaceId('US')).toBe('ATVPDKIKX0DER');
    expect(getMarketplaceId('DE')).toBe('A1PA6795UKMFR9');
    expect(() => getRegionByCountry('JP')).toThrow();
  });
  it('uses CSV arrays and canonical marketplace/includedData order for Catalog 2022', () => {
    const url = buildAmazonUrl('US', `/catalog/2022-04-01/items/${asin}`, {
      includedData: [' summaries ', 'relationships'],
      marketplaceIds: ['ATVPDKIKX0DER'],
    });
    expect(url.search).toBe(
      '?marketplaceIds=ATVPDKIKX0DER&includedData=summaries%2Crelationships',
    );
    expect(identifyOperation('GET', url.pathname)).toBe('getCatalogItem');
    expect(identifyOperation('GET', '/catalog/2022-04-01/items')).toBe(
      'searchCatalogItems',
    );
    expect(identifyOperation('POST', '/catalog/2022-04-01/items')).toBe(
      'searchCatalogItems',
    );
  });
  it.each([
    'https://foreign.invalid/x',
    '//foreign.invalid/x',
    '/\\foreign.invalid/x',
    '/x#fragment',
  ])('rejects unsafe token-bearing destinations %s', (path) => {
    expect(() => buildAmazonUrl('US', path)).toThrow();
  });
  it('preserves 2s exponential / 30s fallback / 120s Retry-After bounds', () => {
    expect(retryDelayMs(undefined, 0, 2000, 0)).toBe(2000);
    expect(retryDelayMs(undefined, 5, 2000, 0)).toBe(30000);
    expect(retryDelayMs('15', 0, 2000, 0)).toBe(15000);
    expect(retryDelayMs('9999', 0, 2000, 0)).toBe(120000);
    expect(retryDelayMs('Thu, 01 Jan 1970 00:00:10 GMT', 0, 2000, 0)).toBe(
      10000,
    );
    expect(retryDelayMs('invalid', 0, 2000, 0)).toBe(2000);
  });
});
