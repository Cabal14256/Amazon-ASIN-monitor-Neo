const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');
const express = require('express');
const {
  JSON_BODY_LIMIT_BYTES,
  installBodyParsers,
} = require('../src/middleware/bodyParsers');

const batch = (maximum) => ({
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

test('production Legacy JSON parser accepts canonical 1000-row bodies and bounds oversize input', async () => {
  const app = express();
  installBodyParsers(app);
  let dispatched = 0;
  app.post('/api/v1/asins/batch-create', (req, res) => {
    dispatched++;
    res.json({ count: req.body.items.length });
  });
  app.use((error, _req, res, _next) => {
    res.status(error.statusCode || 500).json({ success: false });
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${
    server.address().port
  }/api/v1/asins/batch-create`;
  try {
    for (const maximum of [false, true]) {
      const body = JSON.stringify(batch(maximum));
      assert.ok(Buffer.byteLength(body) > 100 * 1024);
      assert.ok(Buffer.byteLength(body) < JSON_BODY_LIMIT_BYTES);
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { count: 1000 });
    }
    assert.equal(dispatched, 2);
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(JSON_BODY_LIMIT_BYTES) }),
    });
    assert.equal(response.status, 413);
    assert.equal(dispatched, 2);
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }
});
