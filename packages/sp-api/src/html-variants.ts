import { SpApiError } from './errors';
import { normalizeCountry } from './request';
import type { Country } from './types';

export const MAX_PRODUCT_HTML_BYTES = 2 * 1024 * 1024;
const maxMetadataCharacters = 64 * 1024;
const maxVariants = 2000;
const countries: Record<Country, { domain: string; language: string }> = {
  US: { domain: 'amazon.com', language: 'en-US,en;q=0.9' },
  UK: { domain: 'amazon.co.uk', language: 'en-GB,en;q=0.9' },
  DE: { domain: 'amazon.de', language: 'de-DE,de;q=0.9,en;q=0.8' },
  FR: { domain: 'amazon.fr', language: 'fr-FR,fr;q=0.9,en;q=0.8' },
  IT: { domain: 'amazon.it', language: 'it-IT,it;q=0.9,en;q=0.8' },
  ES: { domain: 'amazon.es', language: 'es-ES,es;q=0.9,en;q=0.8' },
};
export function normalizeProductAsin(asin: string): string {
  const value = typeof asin === 'string' ? asin.trim().toUpperCase() : '';
  if (!/^[A-Z0-9]{10}$/.test(value)) throw new SpApiError('INVALID_INPUT');
  return value;
}
export function buildProductUrl(asin: string, country: string): URL {
  return new URL(
    `/dp/${normalizeProductAsin(asin)}`,
    `https://www.${countries[normalizeCountry(country)].domain}`,
  );
}
export function productLanguage(country: string): string {
  return countries[normalizeCountry(country)].language;
}
function validateHtml(html: string): void {
  if (typeof html !== 'string') throw new SpApiError('INVALID_RESPONSE');
  if (Buffer.byteLength(html) > MAX_PRODUCT_HTML_BYTES)
    throw new SpApiError('BODY_TOO_LARGE');
}
// Preserve Legacy relationship validation (alphabetic first character). Always
// extract a captured VALUE: the ten-letter property name is not a product ID.
const relationAsin = /^[A-Z][A-Z0-9]{9}$/;
export function extractParentAsin(html: string): string | null {
  validateHtml(html);
  for (const pattern of [
    /"parentAsin"\s*:\s*"([^"]{0,128})"/gi,
    /"parent_asin"\s*:\s*"([^"]{0,128})"/gi,
    /\bdata-asin-parent\s*=\s*["']([^"']{0,128})["']/gi,
  ]) {
    for (const match of html.matchAll(pattern)) {
      const value = match[1].toUpperCase();
      if (relationAsin.test(value)) return value;
    }
  }
  return null;
}
export function extractVariantAsins(html: string): string[] {
  validateHtml(html);
  const variants = new Set<string>();
  let blocks = 0;
  const recognizedArrays = new Set<number>();
  for (const source of ['variationDisplayData', 'twisterJsInit']) {
    for (const sourceMatch of html.matchAll(new RegExp(source, 'gi'))) {
      if (++blocks > 64) throw new SpApiError('BODY_TOO_LARGE');
      const start = sourceMatch.index + source.length;
      const end = html.indexOf('}', start);
      const segment = html.slice(
        start,
        Math.min(
          end < 0 ? html.length : end,
          start + maxMetadataCharacters + 1,
        ),
      );
      const marker = /"variationASINs"\s*:/i.exec(segment);
      if (!marker) continue;
      if (segment.length > maxMetadataCharacters)
        throw new SpApiError('BODY_TOO_LARGE');
      const arrayStart = marker.index + marker[0].length;
      const array = /^\s*(\[[^\]]*\])/.exec(segment.slice(arrayStart));
      if (!array) throw new SpApiError('INVALID_RESPONSE');
      let values: unknown;
      try {
        values = JSON.parse(array[1]);
      } catch {
        throw new SpApiError('INVALID_RESPONSE');
      }
      if (!Array.isArray(values)) throw new SpApiError('INVALID_RESPONSE');
      if (values.length > 4096) throw new SpApiError('BODY_TOO_LARGE');
      recognizedArrays.add(start + marker.index);
      for (const candidate of values) {
        if (
          typeof candidate !== 'string' ||
          !relationAsin.test(candidate.toUpperCase())
        )
          throw new SpApiError('INVALID_RESPONSE');
        variants.add(candidate.toUpperCase());
        if (variants.size > maxVariants) throw new SpApiError('BODY_TOO_LARGE');
      }
    }
  }
  for (const marker of html.matchAll(/"variationASINs"\s*:/gi)) {
    if (!recognizedArrays.has(marker.index))
      throw new SpApiError('INVALID_RESPONSE');
  }
  return [...variants];
}

function attributes(tag: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const match of tag.matchAll(
    /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g,
  )) {
    const name = match[1].toLowerCase();
    if (result.has(name)) throw new SpApiError('INVALID_RESPONSE');
    result.set(name, match[2] ?? match[3] ?? match[4]);
  }
  return result;
}
function confirmIdentity(html: string, asin: string, country: Country): void {
  // Advance monotonically, including over unterminated raw-text elements.
  // Repeated opening tags must not trigger repeated scans of the whole suffix.
  let cursor = 0;
  let identity = false,
    title = false,
    tags = 0;
  while ((cursor = html.indexOf('<', cursor)) !== -1) {
    if (html.startsWith('<!--', cursor)) {
      const end = html.indexOf('-->', cursor + 4);
      if (end < 0) throw new SpApiError('INVALID_RESPONSE');
      cursor = end + 3;
      continue;
    }
    const end = html.indexOf('>', cursor + 1);
    if (end < 0) throw new SpApiError('INVALID_RESPONSE');
    if (++tags > 100000 || end - cursor + 1 > 8192)
      throw new SpApiError('BODY_TOO_LARGE');
    const tag = html.slice(cursor, end + 1);
    cursor = end + 1;
    const inert = /^<(script|style|textarea|template)\b/i.exec(tag);
    if (inert) {
      const closingPattern = new RegExp(`</${inert[1]}\\s*>`, 'gi');
      closingPattern.lastIndex = cursor;
      const closing = closingPattern.exec(html);
      if (!closing) throw new SpApiError('INVALID_RESPONSE');
      if (
        inert[1].toLowerCase() === 'template' &&
        /<template\b/i.test(html.slice(cursor, closing.index))
      )
        throw new SpApiError('INVALID_RESPONSE');
      cursor = closing.index + closing[0].length;
      continue;
    }
    if (!/^<(?:input|link|h1|span)\b/i.test(tag)) continue;
    const attrs = attributes(tag);
    if (/^<(?:h1|span)\b/i.test(tag) && attrs.get('id') === 'productTitle') {
      const nextTag = html.indexOf('<', cursor);
      if (nextTag >= cursor && /\S/.test(html.slice(cursor, nextTag)))
        title = true;
    }
    if (
      /^<input\b/i.test(tag) &&
      [attrs.get('id'), attrs.get('name')].includes('ASIN')
    ) {
      if (attrs.get('value')?.toUpperCase() !== asin)
        throw new SpApiError('INVALID_RESPONSE');
      identity = true;
    }
    if (
      /^<link\b/i.test(tag) &&
      attrs.get('rel')?.toLowerCase().split(/\s+/).includes('canonical')
    ) {
      let url: URL;
      try {
        url = new URL(attrs.get('href') ?? '');
      } catch {
        throw new SpApiError('INVALID_RESPONSE');
      }
      const product = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/i.exec(
        url.pathname,
      );
      if (
        url.protocol !== 'https:' ||
        url.port ||
        url.username ||
        url.password ||
        ![
          countries[country].domain,
          `www.${countries[country].domain}`,
        ].includes(url.hostname) ||
        product?.[1].toUpperCase() !== asin
      )
        throw new SpApiError('INVALID_RESPONSE');
      identity = true;
    }
  }
  if (!identity || !title) throw new SpApiError('INVALID_RESPONSE');
}
export interface HtmlVariantRelations {
  hasVariants: boolean;
  variantCount: number;
  parentAsin: string | null;
  variantAsins: string[];
}
export function parseHtmlVariantPage(
  html: string,
  asin: string,
  country: string,
): HtmlVariantRelations {
  validateHtml(html);
  const product = normalizeProductAsin(asin),
    normalizedCountry = normalizeCountry(country);
  if (
    /robot check|validatecaptcha|enter the characters you see below|api-services-support@amazon\.com/i.test(
      html,
    )
  )
    throw new SpApiError('INVALID_RESPONSE');
  confirmIdentity(html, product, normalizedCountry);
  const parentAsin = extractParentAsin(html),
    variantAsins = extractVariantAsins(html);
  if (
    !parentAsin &&
    /"parent(?:Asin|_asin)"\s*:|\bdata-asin-parent\s*=/i.test(html)
  )
    throw new SpApiError('INVALID_RESPONSE');
  return {
    hasVariants: !!parentAsin || variantAsins.length > 0,
    variantCount: variantAsins.length,
    parentAsin,
    variantAsins,
  };
}
