const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');
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

function legacyBatchController(domain) {
  const events = { normalized: 0, transactions: 0, queries: 0, inserted: 0 };
  const logger = { info() {}, warn() {}, error() {} };
  const load = (path, dependencies) => {
    const module = { exports: {} };
    vm.runInNewContext(readFileSync(resolve(__dirname, path), 'utf8'), {
      module,
      exports: module.exports,
      process: { env: {} },
      require(id) {
        if (!Object.hasOwn(dependencies, id))
          throw new Error(`Unexpected Legacy dependency: ${id}`);
        return dependencies[id];
      },
    });
    return module.exports;
  };
  const database = {
    async withTransaction(action) {
      events.transactions++;
      return action({
        async query(sql, params = []) {
          events.queries++;
          if (sql.includes('SELECT id, country'))
            return [{ id: 'g', country: 'US' }];
          if (sql.includes('@@SESSION.sql_mode'))
            return [{ sql_mode: 'STRICT_TRANS_TABLES' }];
          if (sql.startsWith('SELECT')) return [];
          if (sql.startsWith('INSERT')) {
            events.inserted += params.length / 10;
            return [];
          }
          if (sql.startsWith('UPDATE')) return [];
          throw new Error('Unexpected Legacy SQL');
        },
      });
    },
  };
  const service = load('../src/services/asinBatchCreateService.js', {
    uuid: { v4: () => `generated-${++events.normalized}` },
    '../config/database': database,
    '../config/competitor-database': database,
    '../models/VariantGroup': { clearCache() {} },
    '../models/CompetitorVariantGroup': { clearCache() {} },
    '../utils/logger': logger,
  });
  const shared = load('../src/services/sharedService.js', {
    '../utils/logger': logger,
  });
  const controller = load(
    `../src/controllers/${
      domain === 'asin' ? 'asinController' : 'competitorAsinController'
    }.js`,
    {
      '../models/VariantGroup': {},
      '../models/ASIN': {},
      '../models/CompetitorVariantGroup': {},
      '../models/CompetitorASIN': {},
      '../utils/logger': logger,
      '../services/importService': {},
      '../services/taskRegistryService': {},
      '../services/batchDeleteTaskQueue': {},
      '../services/batchDeleteService': {},
      '../services/asinBatchCreateService': service,
      '../services/sharedService': shared,
    },
  );
  return {
    events,
    handler:
      domain === 'asin'
        ? controller.batchCreateASINs
        : controller.batchCreateCompetitorASINs,
  };
}

for (const domain of ['asin', 'competitor']) {
  test(`actual Legacy ${domain} HTTP controller bounds rows before normalization or database work`, async () => {
    const f = legacyBatchController(domain);
    const app = express();
    installBodyParsers(app);
    const path = `/api/v1/${
      domain === 'asin' ? '' : 'competitor/'
    }asins/batch-create`;
    let received = 0;
    app.post(path, (req, res) => {
      // Model an authenticated writer; execute the actual controller and service.
      req.user = { userId: 'fixture-writer' };
      received++;
      return f.handler(req, res);
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}${path}`;
    const items = (count) =>
      Array.from({ length: count }, (_, index) => ({
        asin: `B${String(index).padStart(9, '0')}`,
        country: 'US',
        site: 'amazon.com',
        brand: 'Fixture',
        parentId: 'g',
      }));
    const post = (count) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ items: items(count) }),
      });
    try {
      for (const count of [1001, 10000]) {
        assert.ok(
          Buffer.byteLength(JSON.stringify({ items: items(count) })) <
            JSON_BODY_LIMIT_BYTES,
        );
        const response = await post(count);
        assert.equal(response.status, 400);
        const result = await response.json();
        assert.equal(result.success, false);
        assert.equal(result.errorCode, 400);
        assert.match(result.errorMessage, /1000/);
        assert.deepEqual(f.events, {
          normalized: 0,
          transactions: 0,
          queries: 0,
          inserted: 0,
        });
      }
      assert.equal(received, 2);
      const response = await post(1000);
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.equal(result.success, true);
      assert.equal(result.data.total, 1000);
      assert.equal(result.data.successCount, 1000);
      assert.equal(result.data.failedCount, 0);
      assert.equal(result.data.results.length, 1000);
      assert.equal(f.events.normalized, 1000);
      assert.equal(f.events.transactions, 1);
      assert.equal(f.events.inserted, 1000);
      assert.equal(received, 3);
    } finally {
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    }
  });
}
