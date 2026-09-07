import { SpApiError } from './errors';
import type { Region } from './types';

export const OPERATION_QUOTAS = Object.freeze({
  getCatalogItem: Object.freeze({
    rate: 2,
    burst: 2,
    perMinute: 120,
    perHour: 7200,
  }),
  searchCatalogItems: Object.freeze({
    rate: 2,
    burst: 2,
    perMinute: 120,
    perHour: 7200,
  }),
  default: Object.freeze({ rate: 0.5, burst: 1, perMinute: 30, perHour: 500 }),
});
export type QuotaOperation = keyof typeof OPERATION_QUOTAS;
export interface QuotaSettings {
  readonly prefix: string;
  readonly regionPerMinute: number;
  readonly regionPerHour: number;
  readonly safetyFactor: number;
  readonly burstCap?: number;
}
export const DEFAULT_QUOTA_SETTINGS: QuotaSettings = Object.freeze({
  prefix: 'spapi:ratelimiter',
  regionPerMinute: 45,
  regionPerHour: 2700,
  safetyFactor: 0.75,
});
export interface QuotaMetadata {
  rate: number;
  burst: number;
  updatedAt?: string;
}
export interface QuotaWindow {
  key: string;
  limit: number;
  windowMs: number;
  ttlMs: number;
  /** Token-bucket refill for the Legacy-compatible memory fallback. */
  rate: number;
}

export function resolveQuotaSettings(
  env: Readonly<Record<string, unknown>>,
): QuotaSettings {
  const number = (key: string, fallback: number, integer = true) => {
    const raw = env[key];
    if (raw === undefined || raw === null || raw === '') return fallback;
    if (typeof raw !== 'string' && typeof raw !== 'number')
      throw new SpApiError('INVALID_CONFIG');
    const value = Number(raw);
    if (
      !Number.isFinite(value) ||
      value <= 0 ||
      value > 1_000_000 ||
      (integer && !Number.isInteger(value))
    )
      throw new SpApiError('INVALID_CONFIG');
    return value;
  };
  const prefix =
    env.RATE_LIMITER_KEY_PREFIX === undefined
      ? DEFAULT_QUOTA_SETTINGS.prefix
      : env.RATE_LIMITER_KEY_PREFIX;
  if (
    typeof prefix !== 'string' ||
    !prefix.trim() ||
    prefix.length > 200 ||
    /[\x00-\x20\x7f]/.test(prefix.trim())
  )
    throw new SpApiError('INVALID_CONFIG');
  const cap = env.SP_API_RATE_LIMIT_BURST_CAP;
  return Object.freeze({
    prefix: prefix.trim(),
    regionPerMinute: number('SP_API_RATE_LIMIT_PER_MINUTE', 45),
    regionPerHour: number('SP_API_RATE_LIMIT_PER_HOUR', 2700),
    safetyFactor: Math.min(
      number('SP_API_RATE_LIMIT_SAFETY_FACTOR', 0.75, false),
      1,
    ),
    burstCap:
      cap === undefined || cap === null || cap === ''
        ? undefined
        : number('SP_API_RATE_LIMIT_BURST_CAP', 1),
  });
}

export function isQuotaOperation(
  operation: string,
): operation is QuotaOperation {
  return Object.hasOwn(OPERATION_QUOTAS, operation);
}

export function operationLimits(
  settings: QuotaSettings,
  operation: string,
  metadata?: Pick<QuotaMetadata, 'rate' | 'burst'>,
) {
  if (!isQuotaOperation(operation)) throw new SpApiError('INVALID_INPUT');
  const config = OPERATION_QUOTAS[operation];
  const effectiveRate = (metadata?.rate ?? config.rate) * settings.safetyFactor;
  const burst = metadata?.burst ?? config.burst;
  return {
    effectiveRate,
    perMinute: Math.min(
      Math.max(Math.floor(effectiveRate * 60), 1),
      Math.max(Math.floor(config.perMinute * settings.safetyFactor), 1),
    ),
    perHour: Math.min(
      Math.max(Math.floor(effectiveRate * 3600), 1),
      Math.max(Math.floor(config.perHour * settings.safetyFactor), 1),
    ),
    burst: Math.max(
      settings.burstCap === undefined
        ? Math.floor(burst * settings.safetyFactor)
        : Math.min(Math.floor(burst), settings.burstCap),
      1,
    ),
  };
}

export function parseQuotaMetadata(
  raw: string | null | undefined,
): QuotaMetadata | undefined {
  if (!raw || raw.length > 4096) return;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const record = value as Record<string, unknown>;
    if (!['string', 'number'].includes(typeof record.rate)) return;
    const rate = Number(record.rate);
    if (!Number.isFinite(rate) || rate <= 0 || rate > 1_000_000) return;
    const candidate = ['string', 'number'].includes(typeof record.burst)
      ? Number(record.burst)
      : 0;
    const burst =
      Number.isFinite(candidate) && candidate > 0 && candidate <= 1_000_000
        ? candidate
        : 1;
    const time = record.updatedAt;
    const updatedAt =
      typeof time === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(time) &&
      Number.isFinite(Date.parse(time)) &&
      new Date(time).toISOString() === time
        ? time
        : undefined;
    return { rate, burst, updatedAt };
  } catch {
    return;
  }
}

export function quotaMetadataKey(
  settings: QuotaSettings,
  region: Region,
  operation: QuotaOperation,
) {
  return `${settings.prefix}:metadata:${region}:operation:${operation}`;
}

export function buildQuotaWindows(
  settings: QuotaSettings,
  region: Region,
  operation: string,
  metadata?: QuotaMetadata,
): QuotaWindow[] {
  if (!['US', 'EU'].includes(region) || !isQuotaOperation(operation))
    throw new SpApiError('INVALID_INPUT');
  const limits = operationLimits(settings, operation, metadata);
  const window = (
    name: string,
    label: string,
    limit: number,
    windowMs: number,
    ttlMs: number,
    rate = limit / (windowMs / 1000),
  ): QuotaWindow => ({
    key: `${settings.prefix}:${region}:${name}:${label}`,
    limit,
    windowMs,
    ttlMs,
    rate,
  });
  return [
    window('region', 'minute', settings.regionPerMinute, 60_000, 120_000),
    window('region', 'hour', settings.regionPerHour, 3600_000, 7200_000),
    window(
      `operation:${operation}`,
      'second',
      limits.burst,
      1000,
      10_000,
      limits.effectiveRate,
    ),
    window(
      `operation:${operation}`,
      'minute',
      limits.perMinute,
      60_000,
      120_000,
    ),
    window(
      `operation:${operation}`,
      'hour',
      limits.perHour,
      3600_000,
      7200_000,
    ),
  ];
}
