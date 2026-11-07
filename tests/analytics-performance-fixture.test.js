const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  COLUMNS,
  buildFixtureConfig,
  datasetManifest,
  fixtureBatches,
  fixtureDigest,
  fixtureRow,
} = require('../scripts/analytics-performance-fixture');
const { buildConfig, buildMatrix } = require('../scripts/benchmark-analytics');

const enabled = {
  GITHUB_ACTIONS: 'true',
  RUN_NEO_ANALYTICS_PERFORMANCE: 'true',
  GITHUB_RUN_ID: '1234',
  GITHUB_RUN_ATTEMPT: '1',
};

test('the launcher cannot accidentally target local or production databases', () => {
  for (const env of [
    {},
    { ...enabled, GITHUB_ACTIONS: 'false' },
    { ...enabled, RUN_NEO_ANALYTICS_PERFORMANCE: 'false' },
    { ...enabled, NODE_ENV: 'production' },
    { ...enabled, GITHUB_RUN_ID: '1234;DROP DATABASE production' },
    { ...enabled, GITHUB_RUN_ATTEMPT: '../outside' },
    { ...enabled, ANALYTICS_PERFORMANCE_ROWS: '100' },
    { ...enabled, ANALYTICS_PERFORMANCE_ROWS: '720001' },
  ]) {
    assert.throws(() => buildFixtureConfig(env));
  }
  const config = buildFixtureConfig({
    ...enabled,
    DATABASE_URL: 'postgresql://production.invalid/production',
    DB_HOST: 'production.invalid',
    REDIS_URL: 'redis://production.invalid/0',
  });
  assert.equal(config.postgresHost, '127.0.0.1');
  assert.equal(config.mysqlHost, '127.0.0.1');
  assert.equal(config.redisUrl, 'redis://127.0.0.1:6379/14');
  assert.deepEqual(new Set(Object.values(config.names)).size, 4);
  assert.ok(
    Object.values(config.names).every((name) => /^[a-z_]+_1234_1$/.test(name)),
  );
  assert.notDeepEqual(
    config.names,
    buildFixtureConfig({ ...enabled, GITHUB_RUN_ATTEMPT: '2' }).names,
  );
});

test('the exact shared SQL series distribution crosses both month windows', () => {
  assert.equal(fixtureRow(1).length, COLUMNS.length);
  assert.deepEqual(fixtureRow(1).slice(0, 10), [
    'perf-group-0',
    'Performance group 0',
    'perf-asin-0',
    'P000000001',
    'Performance ASIN 0',
    'store-0',
    'brand-0',
    'ASIN',
    'US',
    false,
  ]);
  assert.equal(fixtureRow(11)[9], true);
  assert.equal(fixtureRow(25)[10], '2040-01-01 00:05:45');
  assert.equal(fixtureRow(240000)[10], '2040-02-09 22:14:15');
  assert.equal(fixtureRow(720000)[10], '2040-02-29 18:54:15');
  assert.deepEqual(JSON.parse(fixtureRow(11)[11]), {
    fixture: 'P1-T4b',
    sequence: 11,
  });
});

test('bounded generation preserves every row once and detects content drift', () => {
  const batches = [...fixtureBatches(25, 12)];
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [12, 12, 1],
  );
  assert.deepEqual(
    batches.flat(),
    Array.from({ length: 25 }, (_, i) => fixtureRow(i + 1)),
  );
  assert.equal(fixtureDigest(25), fixtureDigest(25));
  assert.notEqual(fixtureDigest(25), fixtureDigest(24));
  assert.throws(() => fixtureBatches(25, 5001).next());
});

test('the real benchmark keeps twenty paired samples and twenty-four strict 3x cases', () => {
  const fixture = buildFixtureConfig(enabled);
  const manifest = datasetManifest(fixture.rows, fixtureDigest(25));
  const config = buildConfig({
    'old-base': `${fixture.legacyBase}/api/`,
    'new-base': `${fixture.neoBase}/api/v1/`,
    'hot-start-time': manifest.windows.hot.startTime,
    'hot-end-time': manifest.windows.hot.endTime,
    'cold-start-time': manifest.windows.cold.startTime,
    'cold-end-time': manifest.windows.cold.endTime,
    ...manifest.filter,
    'variant-group-id': manifest.filter.variantGroupId,
    'environment-label': 'isolated-github-services',
    'dataset-rows': fixture.rows,
    'dataset-profile': manifest.profile,
    runs: fixture.iterations,
    warmup: fixture.warmup,
    'min-speedup': fixture.requiredP95Speedup,
  });
  assert.equal(config.oldBase, `${fixture.legacyBase}/api/v1`);
  assert.equal(config.newBase, `${fixture.neoBase}/api/v1`);
  assert.equal(config.runs, 20);
  assert.equal(config.warmup, 2);
  assert.equal(config.minSpeedup, 3);
  const matrix = buildMatrix(config);
  assert.equal(matrix.length, 28);
  assert.equal(matrix.filter((item) => item.performanceRequired).length, 24);
  assert.equal(matrix.filter((item) => !item.performanceRequired).length, 4);
});
