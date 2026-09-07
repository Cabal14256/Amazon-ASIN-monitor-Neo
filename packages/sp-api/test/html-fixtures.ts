import type { HttpResponse } from '../src/types';

export const asin = 'B000000001';
export const parent = 'B000000002';
export const productPage = (data = '') =>
  `<html><head><link rel="canonical" href="https://www.amazon.com/dp/${asin}"></head><body><input id="ASIN" value="${asin}"><span id="productTitle">Fixture product</span><script>${data}</script></body></html>`;
export const htmlResponse = (
  body = productPage(),
  statusCode = 200,
): HttpResponse => ({
  body,
  statusCode,
  headers: { 'content-type': 'text/html; charset=UTF-8' },
});
