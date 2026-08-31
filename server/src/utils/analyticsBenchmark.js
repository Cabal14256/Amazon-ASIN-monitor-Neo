const ANALYTICS_CACHE_BYPASS_HEADER = 'x-analytics-cache-bypass';

function isAnalyticsCacheBypassRequested(headerValue) {
  const value = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return String(value || '').trim() === '1';
}

function isAnalyticsCacheBypassEnabled(headerValue, environment = process.env) {
  return (
    isAnalyticsCacheBypassRequested(headerValue) &&
    environment.ANALYTICS_BENCHMARK_CACHE_BYPASS_ENABLED === '1'
  );
}

module.exports = {
  ANALYTICS_CACHE_BYPASS_HEADER,
  isAnalyticsCacheBypassEnabled,
  isAnalyticsCacheBypassRequested,
};
