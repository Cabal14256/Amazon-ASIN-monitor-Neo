import { SpApiError } from './errors';
import { safeCount, TelemetryClock, validateWindow } from './telemetry-window';
import type { Logger, Region } from './types';

export const SP_API_ERROR_TYPES = Object.freeze([
  'RATE_LIMIT',
  'AUTH_ERROR',
  'FORBIDDEN',
  'NOT_FOUND',
  'INVALID_INPUT',
  'SERVER_ERROR',
  'NETWORK_ERROR',
  'TIMEOUT',
  'UNKNOWN',
] as const);
export type SpApiErrorType = (typeof SP_API_ERROR_TYPES)[number];
interface Bucket {
  count: number;
  lastOccurred: number | null;
  recentWindow: number[];
}
interface Event {
  timestamp: number;
  type: SpApiErrorType;
  region: Region;
  statusCode: number | null;
}
function buckets() {
  return Object.fromEntries<Bucket>(
    SP_API_ERROR_TYPES.map((type) => [
      type,
      { count: 0, lastOccurred: null, recentWindow: [] },
    ]),
  ) as Record<SpApiErrorType, Bucket>;
}
const iso = (value: number | null) =>
  value === null ? null : new Date(value).toISOString();
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
function status(error: unknown) {
  const value = object(error),
    response = object(value?.response);
  const candidate =
    value?.statusCode ?? response?.statusCode ?? response?.status;
  const number =
    typeof candidate === 'number'
      ? candidate
      : typeof candidate === 'string' && /^\d{3}$/.test(candidate)
      ? Number(candidate)
      : NaN;
  return Number.isInteger(number) && number >= 100 && number <= 599
    ? number
    : null;
}
/** Legacy text is used only as a bounded fallback for classification; neither it
 * nor any upstream payload/URL/identifier is retained or emitted. */
export function classifySpApiError(error: unknown): SpApiErrorType {
  try {
    const value = object(error);
    if (!value) return 'UNKNOWN';
    const codes = [
      value.code,
      ...(Array.isArray(value.amazonCodes)
        ? value.amazonCodes.slice(0, 16)
        : []),
    ];
    if (codes.includes('QuotaExceeded') || codes.includes('TooManyRequests'))
      return 'RATE_LIMIT';
    const code = status(error);
    if (code === 429) return 'RATE_LIMIT';
    if (code === 401) return 'AUTH_ERROR';
    if (code === 403) return 'FORBIDDEN';
    if (code === 404) return 'NOT_FOUND';
    if (code === 400) return 'INVALID_INPUT';
    if (code !== null && code >= 500) return 'SERVER_ERROR';
    if (codes.includes('TIMEOUT')) return 'TIMEOUT';
    if (codes.includes('INVALID_INPUT')) return 'INVALID_INPUT';
    if (
      codes.some((item) =>
        [
          'ECONNRESET',
          'ECONNREFUSED',
          'ENOTFOUND',
          'EAI_AGAIN',
          'ETIMEDOUT',
        ].includes(typeof item === 'string' ? item : ''),
      )
    )
      return 'NETWORK_ERROR';
    // Structured shared errors have deliberately safe metadata; don't reinterpret
    // the constructor's diagnostic string as an upstream error response.
    if (error instanceof SpApiError) return 'UNKNOWN';
    const message =
      typeof value.message === 'string' ? value.message.slice(0, 4096) : '';
    if (/429|QuotaExceeded|TooManyRequests/.test(message)) return 'RATE_LIMIT';
    if (/401|Unauthorized/.test(message)) return 'AUTH_ERROR';
    if (/403|Forbidden/.test(message)) return 'FORBIDDEN';
    if (/404|NotFound/.test(message)) return 'NOT_FOUND';
    if (/400|Bad Request/.test(message)) return 'INVALID_INPUT';
    if (/500|503|Internal Server Error|Service Unavailable/.test(message))
      return 'SERVER_ERROR';
    if (/ECONNRESET|ENOTFOUND|ETIMEDOUT|network/.test(message))
      return 'NETWORK_ERROR';
    if (/timeout|TIMEOUT/.test(message)) return 'TIMEOUT';
    return 'UNKNOWN';
  } catch {
    return 'UNKNOWN';
  }
}
export class SpApiErrorStatistics {
  private readonly clock: TelemetryClock;
  private byType = buckets();
  private byRegion = { US: buckets(), EU: buckets() };
  private timeSeries: Event[] = [];
  private total = 0;
  constructor(
    private readonly options: { logger: Logger; now?: () => number },
  ) {
    if (typeof options?.logger?.info !== 'function')
      throw new SpApiError('INVALID_CONFIG');
    this.clock = new TelemetryClock(options.now);
  }
  classifyError(error: unknown) {
    return classifySpApiError(error);
  }
  recordErrorAuto(error: unknown, region: Region = 'US') {
    this.recordError(classifySpApiError(error), region, error);
  }
  recordError(type: SpApiErrorType, region: Region = 'US', error?: unknown) {
    if (!SP_API_ERROR_TYPES.includes(type) || !['US', 'EU'].includes(region))
      throw new SpApiError('INVALID_INPUT');
    const now = this.clock.now();
    const bucket = this.byType[type],
      regional = this.byRegion[region][type];
    bucket.count = safeCount(bucket.count);
    bucket.lastOccurred = now;
    bucket.recentWindow.push(now);
    if (bucket.recentWindow.length > 100) bucket.recentWindow.shift();
    regional.count = safeCount(regional.count);
    regional.lastOccurred = now;
    let statusCode: number | null = null;
    try {
      statusCode = status(error);
    } catch {
      /* A hostile diagnostic cannot break recording. */
    }
    this.timeSeries.push({ timestamp: now, type, region, statusCode });
    if (this.timeSeries.length > 1000) this.timeSeries.shift();
    this.total = safeCount(this.total);
  }
  getErrorStats(
    options: { hours?: number; region?: Region; type?: SpApiErrorType } = {},
  ) {
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throw new SpApiError('INVALID_INPUT');
    const { hours = 1, region, type } = options;
    if (
      !Number.isFinite(hours) ||
      hours <= 0 ||
      hours > 168 ||
      (region !== undefined && !['US', 'EU'].includes(region)) ||
      (type !== undefined && !SP_API_ERROR_TYPES.includes(type))
    )
      throw new SpApiError('INVALID_INPUT');
    const cutoff = this.clock.now() - hours * 3_600_000;
    const recent = this.timeSeries.filter(
      (entry) =>
        entry.timestamp > cutoff &&
        (!region || entry.region === region) &&
        (!type || entry.type === type),
    );
    const recentByType: Record<string, number> = {},
      recentByRegion: Record<string, number> = {};
    for (const entry of recent) {
      recentByType[entry.type] = (recentByType[entry.type] ?? 0) + 1;
      recentByRegion[entry.region] = (recentByRegion[entry.region] ?? 0) + 1;
    }
    const types = SP_API_ERROR_TYPES.filter((value) => !type || value === type);
    const regions = (['US', 'EU'] as const).filter(
      (value) => !region || value === region,
    );
    return {
      total: this.total,
      recent: {
        count: recent.length,
        hours,
        byType: recentByType,
        byRegion: recentByRegion,
      },
      byType: Object.fromEntries(
        types.map((value) => {
          const row = this.byType[value];
          return [
            value,
            {
              count: row.count,
              lastOccurred: iso(row.lastOccurred),
              recentWindow: row.recentWindow.map((time) => iso(time)),
            },
          ];
        }),
      ),
      byRegion: Object.fromEntries(
        regions.map((value) => [
          value,
          Object.fromEntries(
            SP_API_ERROR_TYPES.map((errorType) => {
              const row = this.byRegion[value][errorType];
              return [
                errorType,
                { count: row.count, lastOccurred: iso(row.lastOccurred) },
              ];
            }),
          ),
        ]),
      ),
      timeSeries: recent.slice(-100).map((entry) => ({
        ...entry,
        timestamp: iso(entry.timestamp)!,
        message: `SP-API ${entry.type}`,
      })),
    };
  }
  /** Legacy diagnostic ratio over stored errors, not the successful-check denominator. */
  getErrorRate(windowSize = 50) {
    validateWindow(windowSize, 1000);
    const recent = this.timeSeries.slice(-windowSize),
      byType: Record<string, number> = {};
    for (const event of recent)
      byType[event.type] = (byType[event.type] ?? 0) + 1;
    return {
      errorCount: recent.length,
      totalChecks: windowSize,
      errorRate: recent.length / windowSize,
      byType,
    };
  }
  resetStats() {
    this.byType = buckets();
    this.byRegion = { US: buckets(), EU: buckets() };
    this.timeSeries = [];
    this.total = 0;
    this.options.logger.info('SP-API 错误统计已重置');
  }
}
