import { isAbsolute, resolve } from 'node:path';

import { DataMigrationError } from '../migration/errors';

export interface TimescaleAggregateConfig {
  readonly databaseUrl: string;
  readonly windowStart: string;
  readonly windowEnd: string;
  readonly refresh: boolean;
  readonly pageSize: number;
  readonly reportPath: string;
}

const localBoundaryPattern =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

function invalid(scope: string, message: string): never {
  throw new DataMigrationError('AGGREGATE_CONFIG_INVALID', scope, message);
}

function required(
  source: Record<string, string | undefined>,
  name: string,
): string {
  const value = source[name]?.trim();
  if (!value) invalid(`config.${name.toLowerCase()}`, `${name} is required`);
  return value;
}

function postgresUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) throw null;
    if (!decodeURIComponent(parsed.pathname.replace(/^\//, ''))) throw null;
  } catch {
    invalid(
      'config.database_url',
      'DATABASE_URL must be a PostgreSQL URL naming a database',
    );
  }
  return value;
}

function localBoundary(value: string, name: string): number {
  const match = localBoundaryPattern.exec(value);
  if (!match) {
    invalid(
      `config.${name.toLowerCase()}`,
      `${name} must use YYYY-MM-DD HH:mm:ss`,
    );
  }
  const [, year, month, day, hour, minute, second] = match.map(Number);
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second);
  const roundTrip = new Date(timestamp);
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day ||
    roundTrip.getUTCHours() !== hour ||
    roundTrip.getUTCMinutes() !== minute ||
    roundTrip.getUTCSeconds() !== second
  ) {
    invalid(`config.${name.toLowerCase()}`, `${name} is not a real date`);
  }
  if (day !== 1 || hour !== 0 || minute !== 0 || second !== 0) {
    invalid(
      `config.${name.toLowerCase()}`,
      `${name} must be a month boundary so every hour/day/month bucket is complete`,
    );
  }
  return timestamp;
}

function booleanSetting(
  source: Record<string, string | undefined>,
  name: string,
  fallback: boolean,
): boolean {
  const value = source[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  return invalid(`config.${name.toLowerCase()}`, `${name} must be a boolean`);
}

function pageSize(source: Record<string, string | undefined>): number {
  const raw = source.TIMESCALE_AGG_PAGE_SIZE?.trim();
  const value = raw ? Number(raw) : 1_000;
  if (!Number.isInteger(value) || value < 100 || value > 5_000) {
    invalid(
      'config.timescale_agg_page_size',
      'TIMESCALE_AGG_PAGE_SIZE must be an integer between 100 and 5000',
    );
  }
  return value;
}

export function validateTimescaleAggregateConfig(
  config: TimescaleAggregateConfig,
): TimescaleAggregateConfig {
  const start = localBoundary(config.windowStart, 'TIMESCALE_AGG_WINDOW_START');
  const end = localBoundary(config.windowEnd, 'TIMESCALE_AGG_WINDOW_END');
  if (start >= end) {
    invalid(
      'config.timescale_agg_window',
      'aggregate window start must be before end',
    );
  }
  const months =
    (new Date(end).getUTCFullYear() - new Date(start).getUTCFullYear()) * 12 +
    new Date(end).getUTCMonth() -
    new Date(start).getUTCMonth();
  if (months > 120) {
    invalid(
      'config.timescale_agg_window',
      'aggregate window must not exceed 120 months',
    );
  }
  if (
    !Number.isInteger(config.pageSize) ||
    config.pageSize < 100 ||
    config.pageSize > 5_000
  ) {
    invalid(
      'config.timescale_agg_page_size',
      'aggregate page size must be an integer between 100 and 5000',
    );
  }
  if (typeof config.refresh !== 'boolean') {
    invalid(
      'config.timescale_agg_refresh',
      'aggregate refresh must be boolean',
    );
  }
  if (!config.reportPath.trim()) {
    invalid(
      'config.timescale_agg_report_path',
      'aggregate report path must not be empty',
    );
  }
  return Object.freeze({
    databaseUrl: postgresUrl(config.databaseUrl.trim()),
    windowStart: config.windowStart,
    windowEnd: config.windowEnd,
    refresh: config.refresh,
    pageSize: config.pageSize,
    reportPath: config.reportPath.trim(),
  });
}

export function parseTimescaleAggregateConfig(
  source: Record<string, string | undefined>,
  workspaceRoot: string,
): TimescaleAggregateConfig {
  const requestedReportPath =
    source.TIMESCALE_AGG_REPORT_PATH?.trim() ||
    'artifacts/timescale-aggregate/report.json';
  return validateTimescaleAggregateConfig({
    databaseUrl: postgresUrl(required(source, 'DATABASE_URL')),
    windowStart: required(source, 'TIMESCALE_AGG_WINDOW_START'),
    windowEnd: required(source, 'TIMESCALE_AGG_WINDOW_END'),
    refresh: booleanSetting(source, 'TIMESCALE_AGG_REFRESH', true),
    pageSize: pageSize(source),
    reportPath: isAbsolute(requestedReportPath)
      ? requestedReportPath
      : resolve(workspaceRoot, requestedReportPath),
  });
}
