import { describe, expect, it } from 'vitest';
import * as legacy from '../../../../src/utils/amazon';
import { AMAZON_DOMAIN_MAP, buildAmazonProductUrl } from './amazon';

describe('frozen Amazon product link mapping', () => {
  it('preserves all 21 Legacy sites, including countries outside the six monitored markets', () => {
    const domains = {
      US: 'amazon.com',
      CA: 'amazon.ca',
      MX: 'amazon.com.mx',
      BR: 'amazon.com.br',
      UK: 'amazon.co.uk',
      DE: 'amazon.de',
      FR: 'amazon.fr',
      IT: 'amazon.it',
      ES: 'amazon.es',
      NL: 'amazon.nl',
      SE: 'amazon.se',
      PL: 'amazon.pl',
      BE: 'amazon.com.be',
      TR: 'amazon.com.tr',
      AE: 'amazon.ae',
      SA: 'amazon.sa',
      IN: 'amazon.in',
      SG: 'amazon.sg',
      AU: 'amazon.com.au',
      JP: 'amazon.co.jp',
      EG: 'amazon.eg',
    };
    expect(AMAZON_DOMAIN_MAP).toEqual(domains);
    for (const [country, domain] of Object.entries(domains)) {
      expect(buildAmazonProductUrl(' B012345678 ', country)).toBe(
        `https://${domain}/dp/B012345678`,
      );
      expect(buildAmazonProductUrl('B012345678', country)).toBe(
        legacy.buildAmazonProductUrl('B012345678', country),
      );
    }
  });
  it.each([undefined, '', '   '])(
    'returns no link for empty ASIN %s',
    (asin) => {
      expect(buildAmazonProductUrl(asin, 'US', 'amazon.de')).toBe('');
    },
  );
  it.each([
    'amazon.de',
    ' https://amazon.de/path?x=1 ',
    'HTTP://amazon.de/path',
  ])('lets explicit site %s override country and strips its path', (site) => {
    expect(buildAmazonProductUrl('B012345678', 'US', site)).toBe(
      'https://amazon.de/dp/B012345678',
    );
  });
  it.each(['', '   ', 'localhost', '127.0.0.1', 'https://'])(
    'falls back to country for invalid site %s',
    (site) => {
      expect(buildAmazonProductUrl('B012345678', 'JP', site)).toBe(
        'https://amazon.co.jp/dp/B012345678',
      );
    },
  );
  it('does not normalize country case or invent a default country', () => {
    for (const country of [undefined, '', 'us', 'UNKNOWN'])
      expect(buildAmazonProductUrl('B012345678', country)).toBe('');
  });
  it('preserves the Legacy custom-domain and unencoded-ASIN behavior, not an input-validation API', () => {
    expect(
      buildAmazonProductUrl(' A/B ', undefined, 'catalog.example.test/path'),
    ).toBe('https://catalog.example.test/dp/A/B');
    expect(
      buildAmazonProductUrl(' A/B ', undefined, 'catalog.example.test/path'),
    ).toBe(
      legacy.buildAmazonProductUrl(
        ' A/B ',
        undefined,
        'catalog.example.test/path',
      ),
    );
  });
});
