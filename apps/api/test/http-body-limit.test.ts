import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { createHttpAdapter, JSON_BODY_LIMIT_BYTES } from '../src/http-adapter';

const legacy = createRequire(__filename)(
  resolve(__dirname, '../../../server/src/middleware/bodyParsers.js'),
) as { JSON_BODY_LIMIT_BYTES: number };

describe('production Fastify JSON parser', () => {
  it('accepts 1000 ordinary and maximum-width Unicode rows, rejects oversize before dispatch', async () => {
    expect(JSON_BODY_LIMIT_BYTES).toBe(legacy.JSON_BODY_LIMIT_BYTES);
    const adapter = createHttpAdapter({ TRUST_PROXY: undefined });
    const server = adapter.getInstance();
    let dispatched = 0;
    server.post('/api/v1/asins/batch-create', async (request) => {
      dispatched++;
      return { count: (request.body as { items: unknown[] }).items.length };
    });
    try {
      for (const maximum of [false, true]) {
        const body = JSON.stringify({
          items: Array.from({ length: 1000 }, (_, index) => ({
            asin: `B${String(index).padStart(9, '0')}`,
            country: 'US',
            parentId: maximum ? '😀'.repeat(50) : 'a'.repeat(36),
            site: maximum ? '😀'.repeat(100) : 'amazon.com',
            brand: maximum ? '😀'.repeat(100) : 'Fixture',
            name: maximum ? '😀'.repeat(500) : 'Product',
            asinType: '1',
          })),
        });
        expect(Buffer.byteLength(body)).toBeGreaterThan(
          maximum ? 1024 * 1024 : 100 * 1024,
        );
        expect(Buffer.byteLength(body)).toBeLessThan(JSON_BODY_LIMIT_BYTES);
        const response = await server.inject({
          method: 'POST',
          url: '/api/v1/asins/batch-create',
          headers: { 'content-type': 'application/json' },
          payload: body,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ count: 1000 });
      }
      expect(dispatched).toBe(2);
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/asins/batch-create',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify({ padding: 'x'.repeat(JSON_BODY_LIMIT_BYTES) }),
      });
      expect(response.statusCode).toBe(413);
      expect(dispatched).toBe(2);
    } finally {
      await server.close();
    }
  });
});
