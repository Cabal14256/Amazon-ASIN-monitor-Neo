const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

// Execute the actual Legacy service; replace only its SQL/cache/logger transport.
// Real strict MySQL acceptance is covered by the API integration fixture.
async function fixture(items, { count = 4999, strict = true } = {}) {
  const inserted = [],
    events = [];
  let generated = 0,
    cached = 0;
  const query = async (sql, params = []) => {
    if (sql.includes('SELECT id, country')) {
      events.push('parent-lock');
      return [{ id: 'g', country: 'US' }];
    }
    if (sql.includes('SELECT asin, country')) return [];
    if (sql.includes('@@SESSION.sql_mode')) {
      events.push('sql-mode');
      return [
        {
          sql_mode: strict
            ? 'STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION'
            : 'NO_ENGINE_SUBSTITUTION',
        },
      ];
    }
    if (sql.includes('SELECT id FROM')) {
      events.push('current-count');
      return Array.from({ length: count }, (_, index) => ({
        id: `seed-${index}`,
      }));
    }
    if (sql.startsWith('INSERT INTO asins')) {
      const rows = Array.from({ length: params.length / 10 }, (_, index) =>
        params.slice(index * 10, index * 10 + 10),
      );
      if (strict)
        for (const row of rows)
          for (const [index, max, name] of [
            [2, 500, 'name'],
            [4, 10, 'country'],
            [5, 100, 'site'],
            [6, 100, 'brand'],
            [7, 50, 'variant_group_id'],
          ]) {
            if (row[index] != null && [...row[index]].length > max) {
              const error = new Error(
                `Data too long for column '${name}' at row 1`,
              );
              error.code = 'ER_DATA_TOO_LONG';
              throw error;
            }
          }
      inserted.push(...rows);
      return [];
    }
    if (sql.startsWith('UPDATE variant_groups')) return [];
    throw new Error('Unexpected synthetic Legacy SQL');
  };
  const module = { exports: {} };
  vm.runInNewContext(
    readFileSync(
      resolve(__dirname, '../src/services/asinBatchCreateService.js'),
      'utf8',
    ),
    {
      module,
      process: { env: {} },
      require(id) {
        if (id === 'uuid') return { v4: () => `new-${generated++}` };
        if (
          id === '../config/database' ||
          id === '../config/competitor-database'
        )
          return { withTransaction: (action) => action({ query }) };
        if (
          id === '../models/VariantGroup' ||
          id === '../models/CompetitorVariantGroup'
        )
          return {
            clearCache() {
              cached++;
            },
          };
        if (id === '../utils/logger') return { info() {}, warn() {} };
        throw new Error('Unexpected Legacy service dependency');
      },
    },
  );
  return {
    result: JSON.parse(
      JSON.stringify(await module.exports.batchCreateASINs({ items })),
    ),
    inserted,
    events,
    cached,
  };
}
const item = (index) => ({
  asin: `B${String(index).padStart(9, '0')}`,
  country: 'US',
  site: 'amazon.com',
  brand: 'Fixture',
  parentId: 'g',
});
for (const [field, max] of [
  ['name', 500],
  ['site', 100],
  ['brand', 100],
]) {
  test(`strict Legacy capacity excludes unwritable ${field} before counting, retaining the valid row and real row failure`, async () => {
    const f = await fixture([
      item(1),
      { ...item(2), [field]: 'x'.repeat(max + 1) },
    ]);
    assert.equal(f.result.successCount, 1);
    assert.equal(f.result.failedCount, 1);
    assert.deepEqual(
      f.result.results.filter((row) => row.success).map((row) => row.index),
      [0],
    );
    assert.match(f.result.errors[0].message, new RegExp(`column '${field}'`));
    assert.equal(f.inserted.length, 1);
    assert.equal(f.cached, 1);
    assert.ok(f.events.indexOf('sql-mode') > f.events.indexOf('parent-lock'));
  });
}
test('non-strict MySQL truncation candidates remain counted and cannot exceed a full group', async () => {
  const f = await fixture([{ ...item(1), name: 'x'.repeat(501) }], {
    count: 5000,
    strict: false,
  });
  assert.equal(f.result.successCount, 0);
  assert.match(f.result.errors[0].message, /5000/);
  assert.equal(f.inserted.length, 0);
});
test('MySQL-storable NUL content remains counted at capacity', async () => {
  const f = await fixture([{ ...item(1), name: 'NUL\0content' }], {
    count: 5000,
  });
  assert.equal(f.result.successCount, 0);
  assert.match(f.result.errors[0].message, /5000/);
  assert.equal(f.inserted.length, 0);
});
test('storage lengths use Unicode codepoints and normalized values at the exact boundary', async () => {
  const f = await fixture([
    {
      ...item(1),
      name: '😀'.repeat(500),
      site: ` ${'s'.repeat(100)} `,
      brand: 'b'.repeat(100),
    },
  ]);
  assert.equal(f.result.successCount, 1);
  assert.equal(f.result.failedCount, 0);
  assert.equal(f.inserted.length, 1);
});
