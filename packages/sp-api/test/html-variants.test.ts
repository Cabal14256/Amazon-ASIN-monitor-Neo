import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  buildProductUrl,
  extractParentAsin,
  extractVariantAsins,
  parseHtmlVariantPage,
} from '../src/html-variants';
import { asin, parent, productPage } from './html-fixtures';
const legacy = (() => {
  const module = {
    exports: {} as {
      buildProductUrl(asin: string, country: string): string;
      extractParentAsin(html: string): string | null;
      extractVariantAsins(html: string): string[];
    },
  };
  runInNewContext(
    readFileSync(
      resolve(__dirname, '../../../server/src/services/htmlScraperService.js'),
      'utf8',
    ),
    {
      module,
      require(name: string) {
        if (name === 'axios') return {};
        if (name === '../utils/logger')
          return { debug() {}, info() {}, warn() {}, error() {} };
        throw new Error('Unexpected HTML fixture dependency');
      },
    },
  );
  return module.exports;
})();
describe('HTML product relation parsing / actual Legacy fixtures', () => {
  it.each(['US', 'UK', 'DE', 'FR', 'IT', 'ES'])(
    'preserves fixed product URL for %s',
    (country) => {
      expect(buildProductUrl(asin, country).toString()).toBe(
        legacy.buildProductUrl(asin, country),
      );
    },
  );
  it.each([
    `"parentAsin":"${parent}"`,
    `"parent_asin": "${parent.toLowerCase()}"`,
    `data-asin-parent="${parent}"`,
    `twisterJsInit: {"parentAsin":"${parent}"}`,
    `variationDisplayData: {"parentAsin":"${parent}"}`,
  ])('preserves normal parent extraction %s', (html) => {
    expect(extractParentAsin(html)).toBe(legacy.extractParentAsin(html));
    expect(extractParentAsin(html)).toBe(parent);
  });
  it('preserves ordered deduplicated variation arrays from both supported source blocks', () => {
    const html = `variationDisplayData: { "variationASINs": ["${asin}","${parent}","${asin.toLowerCase()}"] }; twisterJsInit: {"variationASINs":["B000000003","${parent}"]}`;
    expect(extractVariantAsins(html)).toEqual([
      ...legacy.extractVariantAsins(html),
    ]);
    expect(extractVariantAsins(html)).toEqual([asin, parent, 'B000000003']);
  });
  it('preserves source positions after Unicode text whose lowercase representation changes length', () => {
    const html = `${'İ'.repeat(
      128,
    )} variationDisplayData:{"variationASINs":["${asin}"]}`;
    expect(extractVariantAsins(html)).toEqual([asin]);
  });
  it('fixes the confirmed Legacy bug that interprets the property name itself as an ASIN', () => {
    const html = `"parentAsin":"0000000000","parentAsin":"${parent}"`;
    expect(legacy.extractParentAsin(html)).toBe('PARENTASIN');
    expect(extractParentAsin(html)).toBe(parent);
  });
  it('returns compatible relationships only for a confirmed product identity', () => {
    const html = productPage(
      `"parentAsin":"${parent}", variationDisplayData:{"variationASINs":["${asin}","${parent}"]}`,
    );
    expect(parseHtmlVariantPage(html, asin, 'US')).toEqual({
      hasVariants: true,
      variantCount: 2,
      parentAsin: parent,
      variantAsins: [asin, parent],
    });
    expect(parseHtmlVariantPage(productPage(), asin, 'US')).toEqual({
      hasVariants: false,
      variantCount: 0,
      parentAsin: null,
      variantAsins: [],
    });
  });
  it('recognizes single-quoted/reordered HTML identity attributes without executing scripts', () => {
    const html = `<input value='${asin}' name='ASIN' type='hidden'><h1 id='productTitle'>Fixture</h1><script>throw Error('must-not-execute');</script>`;
    expect(parseHtmlVariantPage(html, asin, 'US').hasVariants).toBe(false);
  });
  it.each([
    'Robot Check',
    'validateCaptcha',
    'Enter the characters you see below',
    'api-services-support@amazon.com',
  ])('rejects challenge/error pages containing %s', (marker) => {
    expect(() => parseHtmlVariantPage(productPage(marker), asin, 'US')).toThrow(
      'INVALID_RESPONSE',
    );
  });
  it.each([
    '',
    '<html>Temporary failure</html>',
    '<script>"parentAsin":"B000000002"</script>',
  ])(
    'does not turn missing product evidence into a no-variants result',
    (html) => {
      expect(() => parseHtmlVariantPage(html, asin, 'US')).toThrow(
        'INVALID_RESPONSE',
      );
    },
  );
  it('rejects mismatched product, country or malformed relationship metadata', () => {
    expect(() =>
      parseHtmlVariantPage(productPage().replaceAll(asin, parent), asin, 'US'),
    ).toThrow('INVALID_RESPONSE');
    expect(() => parseHtmlVariantPage(productPage(), asin, 'DE')).toThrow(
      'INVALID_RESPONSE',
    );
    expect(() =>
      parseHtmlVariantPage(productPage('"parentAsin":"invalid"'), asin, 'US'),
    ).toThrow('INVALID_RESPONSE');
  });
  it('normalizes accepted input and rejects country/path injection', () => {
    expect(buildProductUrl(` ${asin.toLowerCase()} `, ' us ').toString()).toBe(
      `https://www.amazon.com/dp/${asin}`,
    );
    for (const value of [
      '../secret',
      `${asin}?secret=fixture`,
      'B000000001/extra',
      '',
      null,
    ])
      expect(() => buildProductUrl(value as never, 'US')).toThrow(
        'INVALID_INPUT',
      );
    expect(() => buildProductUrl(asin, 'CA')).toThrow('INVALID_INPUT');
  });
  it('bounds HTML and variant collection rather than returning a truncated product relationship', () => {
    expect(() =>
      parseHtmlVariantPage('x'.repeat(2 * 1024 * 1024 + 1), asin, 'US'),
    ).toThrow('BODY_TOO_LARGE');
    const many = Array.from(
      { length: 2001 },
      (_, index) => `"B${String(index).padStart(9, '0')}"`,
    ).join(',');
    expect(() =>
      extractVariantAsins(`variationDisplayData:{"variationASINs":[${many}]}`),
    ).toThrow('BODY_TOO_LARGE');
  });
  it.each(['script', 'style', 'textarea', 'template'])(
    'does not use product markup inside %s as page identity',
    (tag) => {
      const identity = `<input id="ASIN" value="${asin}"><h1 id="productTitle">Fixture</h1>`;
      expect(() =>
        parseHtmlVariantPage(`<${tag}>${identity}</${tag}>`, asin, 'US'),
      ).toThrow('INVALID_RESPONSE');
      expect(() =>
        parseHtmlVariantPage(`<${tag}>${identity}`, asin, 'US'),
      ).toThrow('INVALID_RESPONSE');
    },
  );
  it('rejects commented, conflicting or malformed identity markup', () => {
    for (const html of [
      `<!--${productPage()}-->`,
      productPage().replace(`id="ASIN"`, `id="ASIN" id="ASIN"`),
      productPage().replace(
        'https://www.amazon.com',
        'https://www.amazon.com.evil.invalid',
      ),
      productPage() + `<input id="ASIN" value="${parent}">`,
    ])
      expect(() => parseHtmlVariantPage(html, asin, 'US')).toThrow(
        'INVALID_RESPONSE',
      );
  });
  it('requires actual title markup and rejects identity hidden in nested inert templates', () => {
    for (const html of [
      productPage().replace(
        '<span id="productTitle">Fixture product</span>',
        '<input id="productTitle">',
      ),
      productPage().replace('Fixture product', '   '),
      `<template><template></template>${productPage()}</template>`,
    ])
      expect(() => parseHtmlVariantPage(html, asin, 'US')).toThrow(
        'INVALID_RESPONSE',
      );
  });
  it('rejects malformed and unsupported variation arrays, including after a valid array', () => {
    for (const metadata of [
      'variationDisplayData:{"variationASINs":[null]}',
      'variationDisplayData:{"variationASINs":["bad"]}',
      'variationDisplayData:{"variationASINs":true}',
      'variationDisplayData:{"variationASINs":[',
      `variationDisplayData:{"variationASINs":["${asin}"]};unknown:{"variationASINs":["${parent}"]}`,
    ])
      expect(() =>
        parseHtmlVariantPage(productPage(metadata), asin, 'US'),
      ).toThrow('INVALID_RESPONSE');
  });
  it('bounds source blocks and hostile incomplete tags without unbounded repeated suffix scans', () => {
    expect(() => extractVariantAsins('twisterJsInit:{}'.repeat(65))).toThrow(
      'BODY_TOO_LARGE',
    );
    expect(() =>
      parseHtmlVariantPage('<input '.repeat(100000), asin, 'US'),
    ).toThrow('INVALID_RESPONSE');
    expect(() =>
      parseHtmlVariantPage(`<input ${'x'.repeat(8193)}>`, asin, 'US'),
    ).toThrow('BODY_TOO_LARGE');
    expect(() => parseHtmlVariantPage('中'.repeat(700000), asin, 'US')).toThrow(
      'BODY_TOO_LARGE',
    );
  });
});
