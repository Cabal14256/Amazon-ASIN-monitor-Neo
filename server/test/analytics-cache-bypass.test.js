process.env.LOG_LEVEL = 'ERROR';

const assert = require('node:assert/strict');
const test = require('node:test');

const analyticsCacheService = require('../src/services/analyticsCacheService');
const cacheService = require('../src/services/cacheService');
const {
  ANALYTICS_CACHE_BYPASS_HEADER,
  isAnalyticsCacheBypassEnabled,
  isAnalyticsCacheBypassRequested,
} = require('../src/utils/analyticsBenchmark');

test('benchmark cache bypass requires both the explicit header and opt-in environment', () => {
  assert.equal(ANALYTICS_CACHE_BYPASS_HEADER, 'x-analytics-cache-bypass');
  assert.equal(isAnalyticsCacheBypassRequested('1'), true);
  assert.equal(isAnalyticsCacheBypassRequested('0'), false);
  assert.equal(
    isAnalyticsCacheBypassEnabled('1', {
      ANALYTICS_BENCHMARK_CACHE_BYPASS_ENABLED: '0',
    }),
    false,
  );
  assert.equal(
    isAnalyticsCacheBypassEnabled('1', {
      ANALYTICS_BENCHMARK_CACHE_BYPASS_ENABLED: '1',
    }),
    true,
  );
});

test('bypass skips both analytics cache reads and writes', async () => {
  const key = `benchmark-bypass-${process.pid}-${Date.now()}`;
  const cached = { source: 'existing-cache-value' };
  cacheService.set(key, cached, 60_000);
  try {
    assert.deepEqual(await analyticsCacheService.get(key), cached);
    assert.equal(await analyticsCacheService.get(key, { bypass: true }), null);

    await analyticsCacheService.set(
      key,
      { source: 'must-not-replace-cache' },
      60_000,
      { bypass: true },
    );
    assert.deepEqual(await analyticsCacheService.get(key), cached);
  } finally {
    cacheService.delete(key);
  }
});
