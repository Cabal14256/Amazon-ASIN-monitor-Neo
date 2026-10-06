'use strict';

const { createHash } = require('node:crypto');

// Keep the P1-T4b distribution in storage-performance.integration.test.ts.
// This profile is synthetic, contains no production data, and uses wall-clock
// Shanghai timestamps (the persisted MySQL/PG timestamp semantics).
const PROFILE = 'storage-performance-p1-t4b-v1-http';
const SEED = 'P1-T4b:series-id:345-seconds:60-days:v1';
const MINIMUM_ROWS = 720_000;
const COUNTRIES = Object.freeze(['US', 'UK', 'DE', 'FR', 'ES', 'IT']);
const COLUMNS = Object.freeze([
  'variant_group_id',
  'variant_group_name',
  'asin_id',
  'asin_code',
  'asin_name',
  'site_snapshot',
  'brand_snapshot',
  'check_type',
  'country',
  'is_broken',
  'check_time',
  'check_result',
  'notification_sent',
  'create_time',
]);
const WINDOWS = Object.freeze({
  cold: Object.freeze({
    startTime: '2040-01-01 00:00:00',
    endTime: '2040-01-31 23:59:59',
  }),
  hot: Object.freeze({
    startTime: '2040-02-01 00:00:00',
    endTime: '2040-02-29 23:59:59',
  }),
});

function requireInteger(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum ||
    String(parsed) !== String(value)
  ) {
    throw new Error(`${name} is outside the isolated fixture contract`);
  }
  return parsed;
}

function buildFixtureConfig(env) {
  if (
    env.GITHUB_ACTIONS !== 'true' ||
    env.RUN_NEO_ANALYTICS_PERFORMANCE !== 'true' ||
    env.NODE_ENV === 'production'
  ) {
    throw new Error(
      'The HTTP fixture requires an explicitly enabled GitHub job',
    );
  }
  // No arbitrary URL, schema, Redis database, or host overrides are accepted.
  // A job owns fresh services and a dedicated four-database namespace.
  const runId = requireInteger(env.GITHUB_RUN_ID, 'GITHUB_RUN_ID', 1, 10 ** 13);
  const attempt = requireInteger(
    env.GITHUB_RUN_ATTEMPT,
    'GITHUB_RUN_ATTEMPT',
    1,
    1000,
  );
  const suffix = `${runId}_${attempt}`;
  const names = Object.freeze({
    legacyPrimary: `analytics_http_ci_mysql_primary_${suffix}`,
    legacyCompetitor: `analytics_http_ci_mysql_comp_${suffix}`,
    neoPrimary: `analytics_http_ci_pg_primary_${suffix}`,
    neoCompetitor: `analytics_http_ci_pg_comp_${suffix}`,
  });
  const rows = requireInteger(
    env.ANALYTICS_PERFORMANCE_ROWS ?? String(MINIMUM_ROWS),
    'ANALYTICS_PERFORMANCE_ROWS',
    MINIMUM_ROWS,
    2_880_000,
  );
  if (rows % 24 !== 0)
    throw new Error('Fixture rows must contain complete rounds');
  return Object.freeze({
    names,
    rows,
    mysqlHost: '127.0.0.1',
    mysqlPort: 3306,
    postgresHost: '127.0.0.1',
    postgresPort: 5432,
    redisUrl: 'redis://127.0.0.1:6379/14',
    legacyBase: 'http://127.0.0.1:3301',
    neoBase: 'http://127.0.0.1:3310',
    warmup: 2,
    iterations: 20,
    requiredP95Speedup: 3,
  });
}

function wallClock(seconds) {
  return new Date(Date.UTC(2040, 0, 1) + seconds * 1000)
    .toISOString()
    .slice(0, 19)
    .replace('T', ' ');
}

function fixtureRow(sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error('Fixture sequence must be a positive safe integer');
  }
  const entity = (sequence - 1) % 24;
  const group = (sequence - 1) % 12;
  const checkTime = wallClock(
    (Math.floor((sequence - 1) / 24) * 345) % 5_184_000,
  );
  return [
    `perf-group-${group}`,
    `Performance group ${group}`,
    `perf-asin-${entity}`,
    `P${String(entity + 1).padStart(9, '0')}`,
    `Performance ASIN ${entity}`,
    `store-${entity % 3}`,
    `brand-${entity % 4}`,
    'ASIN',
    COUNTRIES[(sequence - 1) % 6],
    sequence % 11 === 0,
    checkTime,
    JSON.stringify({ fixture: 'P1-T4b', sequence }),
    false,
    '2040-01-01 00:00:00',
  ];
}

function* fixtureBatches(rows, batchSize = 1000) {
  if (
    !Number.isSafeInteger(rows) ||
    rows < 1 ||
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 5000
  ) {
    throw new Error('Invalid bounded fixture batch request');
  }
  for (let first = 1; first <= rows; first += batchSize) {
    const batch = [];
    for (
      let sequence = first;
      sequence < first + batchSize && sequence <= rows;
      sequence++
    ) {
      batch.push(fixtureRow(sequence));
    }
    yield batch;
  }
}

function fixtureDigest(rows) {
  const digest = createHash('sha256');
  for (const batch of fixtureBatches(rows)) {
    for (const row of batch) digest.update(`${JSON.stringify(row)}\n`);
  }
  return digest.digest('hex');
}

function datasetManifest(rows, digest) {
  return {
    profile: PROFILE,
    seed: SEED,
    rows,
    columns: COLUMNS,
    canonicalSha256: digest,
    timestampSemantics: 'Shanghai wall-clock timestamp without time zone',
    startInclusive: '2040-01-01 00:00:00',
    endExclusive: '2040-03-01 00:00:00',
    windows: WINDOWS,
    windowMeaning:
      'Earlier/later time ranges; both databases are warmed, not cold OS caches',
    countries: COUNTRIES,
    groups: 12,
    asins: 24,
    sites: 3,
    brands: 4,
    filter: {
      country: 'US',
      site: 'store-0',
      brand: 'brand-0',
      variantGroupId: 'perf-group-0',
    },
    distribution: {
      entity: '(sequence - 1) % 24',
      group: '(sequence - 1) % 12',
      seconds: '(floor((sequence - 1) / 24) * 345) % 5184000',
      broken: 'sequence % 11 = 0',
    },
  };
}

module.exports = {
  COLUMNS,
  COUNTRIES,
  MINIMUM_ROWS,
  PROFILE,
  SEED,
  WINDOWS,
  buildFixtureConfig,
  datasetManifest,
  fixtureBatches,
  fixtureDigest,
  fixtureRow,
};
