import {
  monitorAnalyticsDataSchemas,
  type AnalyticsMeta,
} from '@asin-monitor/contracts';
import {
  formatMonitorSqlDate,
  MonitorAnalyticsQueryError,
  MonitorAnalyticsResultLimitError,
  type MonitorAnalyticsOperation,
} from '@asin-monitor/db';

export const MONITOR_ANALYTICS_RESPONSE_BYTES = 32 * 1024 * 1024;
export type MonitorAnalyticsSource =
  | 'raw'
  | 'agg'
  | 'agg:day-fallback'
  | 'interval';
export interface MonitorAnalyticsData {
  data: unknown;
  source: MonitorAnalyticsSource;
}
export const MONITOR_ANALYTICS_META_OPERATIONS =
  new Set<MonitorAnalyticsOperation>([
    'by-time',
    'all-countries-summary',
    'region-summary',
    'period-summary',
    'period-summary/details',
    'asin-by-country',
    'asin-by-variant-group',
  ]);

/** Reject excessive/cyclic/non-JSON output before JSON.stringify or Zod can
 * allocate another full result. Never truncate a successful response. */
export function assertMonitorJsonBounds(
  value: unknown,
  maxBytes = MONITOR_ANALYTICS_RESPONSE_BYTES,
  ensureOpen: () => void = () => undefined,
) {
  let bytes = 0,
    nodes = 0;
  const ancestors = new Set<object>();
  const add = (size: number) => {
    bytes += size;
    if (bytes > maxBytes) throw new MonitorAnalyticsResultLimitError();
  };
  const visit = (item: unknown, depth: number): void => {
    if (++nodes % 1000 === 0) ensureOpen();
    if (nodes > 2_000_000 || depth > 12)
      throw new MonitorAnalyticsResultLimitError();
    if (typeof item === 'string') {
      if (item.length > maxBytes) throw new MonitorAnalyticsResultLimitError();
      add(Buffer.byteLength(JSON.stringify(item)));
    } else if (item === null || typeof item === 'boolean')
      add(String(item).length);
    else if (typeof item === 'number' && Number.isFinite(item))
      add(JSON.stringify(item).length);
    else if (typeof item === 'object' && item !== null) {
      if (
        ancestors.has(item) ||
        (!Array.isArray(item) &&
          ![Object.prototype, null].includes(Object.getPrototypeOf(item)))
      )
        throw new MonitorAnalyticsQueryError('invalid-result');
      ancestors.add(item);
      add(2);
      if (Array.isArray(item)) {
        if (item.length > 50000) throw new MonitorAnalyticsResultLimitError();
        add(Math.max(0, item.length - 1));
        for (const child of item) visit(child, depth + 1);
      } else {
        const entries = Object.entries(item);
        if (entries.length > 100) throw new MonitorAnalyticsResultLimitError();
        add(Math.max(0, entries.length - 1));
        for (const [key, child] of entries) {
          add(Buffer.byteLength(JSON.stringify(key)) + 1);
          visit(child, depth + 1);
        }
      }
      ancestors.delete(item);
    } else throw new MonitorAnalyticsQueryError('invalid-result');
  };
  ensureOpen();
  visit(value, 0);
  ensureOpen();
}

export function validateMonitorAnalyticsData(
  operation: MonitorAnalyticsOperation,
  data: unknown,
) {
  if (!monitorAnalyticsDataSchemas[operation].safeParse(data).success)
    throw new MonitorAnalyticsQueryError('invalid-result');
}

export function monitorAnalyticsMeta(
  source: MonitorAnalyticsSource,
  generatedAt: number,
  cacheHit: boolean,
): AnalyticsMeta {
  const updated = formatMonitorSqlDate(new Date(generatedAt));
  return {
    source: cacheHit ? `cache+${source}` : source,
    cacheHit,
    cacheTime: cacheHit ? updated : null,
    dataFreshness: cacheHit ? 'cached' : 'fresh',
    lastUpdatedAt: updated,
    busyFallback: false,
    busyReason: null,
  };
}

export function encodeMonitorAnalyticsResult(
  operation: MonitorAnalyticsOperation,
  result: MonitorAnalyticsData,
  generatedAt: number,
  cacheHit: boolean,
  ensureOpen: () => void,
) {
  const response = {
    success: true,
    data: result.data,
    ...(MONITOR_ANALYTICS_META_OPERATIONS.has(operation)
      ? { meta: monitorAnalyticsMeta(result.source, generatedAt, cacheHit) }
      : {}),
    errorCode: 0,
  };
  assertMonitorJsonBounds(
    response,
    MONITOR_ANALYTICS_RESPONSE_BYTES,
    ensureOpen,
  );
  validateMonitorAnalyticsData(operation, result.data);
  ensureOpen();
  const encoded = JSON.stringify(response);
  ensureOpen();
  return encoded;
}
