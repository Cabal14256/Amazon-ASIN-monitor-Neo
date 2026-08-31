const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  atomicWrite,
  buildConfig,
  buildMatrix,
  calcStats,
  comparePairResults,
  comparableResponse,
  digestValue,
  firstDifferencePath,
  joinApiUrl,
  normalizeBaseUrl,
  responseCardinality,
} = require('../scripts/benchmark-analytics');

function completeArgs(overrides = {}) {
  return {
    'old-base': 'http://old.example/api',
    'new-base': 'https://new.example/api/v1/',
    'hot-start-time': '2026-08-24 00:00:00',
    'hot-end-time': '2026-08-31 00:00:00',
    'cold-start-time': '2026-01-01 00:00:00',
    'cold-end-time': '2026-02-01 00:00:00',
    country: 'US',
    site: 'US',
    brand: 'fixture-brand',
    'variant-group-id': 'fixture-group',
    'environment-label': 'integration-fixture',
    'dataset-rows': '500000',
    'dataset-profile': 'synthetic time-series fixture',
    ...overrides,
  };
}

test('API base normalization deduplicates /api and request paths', () => {
  assert.equal(
    normalizeBaseUrl('http://localhost:3100/api/'),
    'http://localhost:3100/api/v1',
  );
  assert.equal(
    normalizeBaseUrl('http://localhost:3100/api/v1/'),
    'http://localhost:3100/api/v1',
  );
  assert.equal(
    joinApiUrl(
      'http://localhost:3100/api/v1',
      '/monitor-history/statistics',
      'country=US',
    ),
    'http://localhost:3100/api/v1/monitor-history/statistics?country=US',
  );
  assert.throws(
    () => normalizeBaseUrl('https://user:secret@example.com'),
    /must not contain credentials/,
  );
});

test('normalization compares business data and excludes volatile meta', () => {
  const oldBody = {
    success: true,
    data: { rows: [{ country: 'US', count: 3 }], total: 1 },
    meta: { source: 'legacy', durationMs: 91 },
    errorCode: 0,
  };
  const newBody = {
    errorCode: 0,
    meta: { source: 'cagg', durationMs: 4 },
    data: { total: 1, rows: [{ count: 3, country: 'US' }] },
    success: true,
  };
  const oldComparable = comparableResponse(oldBody);
  const newComparable = comparableResponse(newBody);
  assert.equal(digestValue(oldComparable), digestValue(newComparable));
  assert.equal(firstDifferencePath(oldComparable, newComparable), null);

  newBody.data.rows[0].count = 4;
  assert.equal(
    firstDifferencePath(oldComparable, comparableResponse(newBody)),
    '$.data.rows[0].count',
  );
});

test('promotion matrix covers two windows, three granularities and filters', () => {
  const config = buildConfig(completeArgs());
  const matrix = buildMatrix(config);
  assert.equal(matrix.length, 28);
  assert.deepEqual([...new Set(matrix.map(({ window }) => window))].sort(), [
    'cold',
    'hot',
  ]);
  assert.deepEqual(
    [
      ...new Set(
        matrix
          .map(({ granularity }) => granularity)
          .filter((value) => value !== 'adaptive'),
      ),
    ].sort(),
    ['day', 'hour', 'month'],
  );
  assert.equal(
    matrix.filter(({ name }) => name.includes('period-filtered')).length,
    6,
  );
  assert.equal(
    matrix.filter(({ name }) => name.includes('variant-group')).length,
    4,
  );
  assert.throws(
    () => buildConfig(completeArgs({ brand: '' })),
    /Missing required --brand/,
  );
  assert.throws(
    () => buildConfig(completeArgs({ runs: '4' })),
    /--runs must be an integer >= 5/,
  );
  assert.throws(
    () => buildConfig(completeArgs({ 'min-speedup': '2.99' })),
    /--min-speedup must be a number >= 3/,
  );
  assert.equal(config.minSpeedup, 3);
  assert.throws(
    () =>
      buildConfig(
        completeArgs({
          'cold-start-time': '2026-08-24 00:00:00',
          'cold-end-time': '2026-08-31 00:00:00',
        }),
      ),
    /--cold-end-time must be earlier than or equal to --hot-start-time/,
  );
  assert.throws(
    () => buildConfig(completeArgs({ 'hot-start-time': 'not-a-time' })),
    /--hot-start-time must be a valid timestamp/,
  );
  assert.throws(
    () =>
      buildConfig(
        completeArgs({
          'cold-start-time': '2026-03-01 00:00:00',
          'cold-end-time': '2026-02-01 00:00:00',
        }),
      ),
    /--cold-start-time must be earlier than --cold-end-time/,
  );
  assert.ok(
    matrix.every(
      (benchmarkCase) =>
        benchmarkCase.expectedStatus === 200 &&
        benchmarkCase.minimumCardinality === 1 &&
        benchmarkCase.cardinalityPath.length > 0,
    ),
  );
});

test('cardinality gate rejects empty and missing business results', () => {
  assert.equal(
    responseCardinality(
      comparableResponse({ success: true, data: { list: [{ id: 1 }] } }),
      ['data', 'list'],
    ),
    1,
  );
  assert.equal(
    responseCardinality(
      comparableResponse({ success: true, data: { list: [] } }),
      ['data', 'list'],
    ),
    0,
  );
  assert.equal(
    responseCardinality(
      comparableResponse({ success: true, data: { totalChecks: 42 } }),
      ['data', 'totalChecks'],
    ),
    42,
  );
  assert.equal(
    responseCardinality(
      comparableResponse({
        success: true,
        data: [
          { region: 'NA', totalChecks: 0 },
          { region: 'EU', totalChecks: '0' },
        ],
      }),
      ['data'],
      'totalChecks',
    ),
    0,
  );
  assert.equal(
    responseCardinality(
      comparableResponse({
        success: true,
        data: [
          { region: 'NA', totalChecks: 4 },
          { region: 'EU', totalChecks: '3' },
        ],
      }),
      ['data'],
      'totalChecks',
    ),
    7,
  );
  assert.equal(
    responseCardinality(comparableResponse({ success: true, data: {} }), [
      'data',
      'list',
    ]),
    null,
  );
});

test('region summaries gate on summed checks instead of fixed region count', () => {
  const regionCase = buildMatrix(buildConfig(completeArgs())).find(({ name }) =>
    name.endsWith('-region'),
  );
  assert.equal(regionCase.cardinalityItemField, 'totalChecks');
  const result = (totalChecks) => ({
    status: 200,
    comparable: comparableResponse({
      success: true,
      data: Array.from({ length: 7 }, (_, index) => ({
        region: `region-${index}`,
        totalChecks,
      })),
    }),
  });
  const emptyRegions = comparePairResults(result(0), result(0), regionCase, 1);
  assert.equal(emptyRegions.oldCardinality, 0);
  assert.equal(emptyRegions.matches, false);
  assert.equal(emptyRegions.differencePath, '$.__cardinality');
});

test('pair comparison rejects empty results and divergent success statuses', () => {
  const benchmarkCase = {
    expectedStatus: 200,
    cardinalityPath: ['data', 'list'],
    minimumCardinality: 1,
  };
  const result = (status, list) => ({
    status,
    comparable: comparableResponse({ success: true, data: { list } }),
  });

  const empty = comparePairResults(
    result(200, []),
    result(200, []),
    benchmarkCase,
    1,
  );
  assert.equal(empty.matches, false);
  assert.equal(empty.cardinalityMatches, false);
  assert.equal(empty.differencePath, '$.__cardinality');

  const divergentStatus = comparePairResults(
    result(200, [{ id: 1 }]),
    result(201, [{ id: 1 }]),
    benchmarkCase,
    2,
  );
  assert.equal(divergentStatus.matches, false);
  assert.equal(divergentStatus.statusesMatch, false);
  assert.equal(divergentStatus.differencePath, '$.__httpStatus');

  const matching = comparePairResults(
    result(200, [{ id: 1 }]),
    result(200, [{ id: 1 }]),
    benchmarkCase,
    3,
  );
  assert.equal(matching.matches, true);
  assert.equal(matching.cardinalityMatches, true);
  assert.equal(matching.statusesMatch, true);
});

test('statistics require successful samples and expose p50/p90/p95', () => {
  const stats = calcStats([
    { ok: true, durationMs: 10 },
    { ok: true, durationMs: 20 },
    { ok: true, durationMs: 30 },
    { ok: true, durationMs: 40 },
    { ok: false, durationMs: 5 },
  ]);
  assert.equal(stats.count, 5);
  assert.equal(stats.successCount, 4);
  assert.equal(stats.failCount, 1);
  assert.equal(stats.p50, 25);
  assert.equal(stats.p90, 37);
  assert.equal(stats.p95, 38.5);
});

test('atomic report writes replace temporary content without leaking token', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'asin-benchmark-'));
  const reportPath = path.join(directory, 'report.json');
  atomicWrite(reportPath, '{"status":"passed"}\n');
  assert.equal(readFileSync(reportPath, 'utf8'), '{"status":"passed"}\n');

  const output = execFileSync(
    process.execPath,
    [
      path.resolve(__dirname, '../scripts/benchmark-analytics.js'),
      ...Object.entries(
        completeArgs({
          'old-base': 'http://old.example/api',
          'new-base': 'http://new.example/api',
        }),
      ).flatMap(([key, value]) => [`--${key}`, value]),
      '--token',
      'must-not-appear',
      '--dry-run',
    ],
    { encoding: 'utf8' },
  );
  assert.doesNotMatch(output, /api\/api/);
  assert.doesNotMatch(output, /must-not-appear/);
});
