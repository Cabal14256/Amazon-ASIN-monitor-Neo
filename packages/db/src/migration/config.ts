import { resolve } from 'node:path';

import { loadEnvironmentFiles } from '@asin-monitor/config';

import { DataMigrationError } from './errors';

export interface DataMigrationConfig {
  readonly mysql: {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly password: string;
    readonly primaryDatabase: string;
    readonly competitorDatabase: string;
  };
  readonly postgres: {
    readonly primaryUrl: string;
    readonly competitorUrl: string;
  };
  readonly batchSize: number;
  readonly sampleSize: number;
  readonly allowTargetReset: boolean;
  readonly reportPath: string;
}

const identifierPattern = /^[a-zA-Z0-9_]+$/;
const trueValues = new Set(['1', 'true', 'yes', 'on']);

function required(
  source: Record<string, string | undefined>,
  name: string,
): string {
  const value = source[name]?.trim();
  if (!value) {
    throw new DataMigrationError(
      'MIGRATION_CONFIG_INVALID',
      `config.${name.toLowerCase()}`,
      `required migration setting ${name} is missing`,
    );
  }
  return value;
}

function integerSetting(
  source: Record<string, string | undefined>,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = source[name]?.trim();
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new DataMigrationError(
      'MIGRATION_CONFIG_INVALID',
      `config.${name.toLowerCase()}`,
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function databaseIdentifier(value: string, settingName: string): string {
  if (!identifierPattern.test(value)) {
    throw new DataMigrationError(
      'MIGRATION_CONFIG_INVALID',
      `config.${settingName.toLowerCase()}`,
      `${settingName} contains unsupported characters`,
    );
  }
  return value;
}

function postgresTargetIdentity(value: string, settingName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new DataMigrationError(
      'MIGRATION_CONFIG_INVALID',
      `config.${settingName.toLowerCase()}`,
      `${settingName} must be a PostgreSQL URL`,
    );
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new DataMigrationError(
      'MIGRATION_CONFIG_INVALID',
      `config.${settingName.toLowerCase()}`,
      `${settingName} must use the postgres or postgresql protocol`,
    );
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!databaseName) {
    throw new DataMigrationError(
      'MIGRATION_CONFIG_INVALID',
      `config.${settingName.toLowerCase()}`,
      `${settingName} must name a target database`,
    );
  }
  const queryHost = parsed.searchParams.get('host');
  const host = parsed.hostname
    ? parsed.hostname.toLowerCase()
    : queryHost
    ? `socket:${queryHost}`
    : '<default>';
  const port = parsed.port || parsed.searchParams.get('port') || '5432';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535) {
    throw new DataMigrationError(
      'MIGRATION_CONFIG_INVALID',
      `config.${settingName.toLowerCase()}`,
      `${settingName} contains an invalid PostgreSQL port`,
    );
  }
  return `${host}\u0000${port}\u0000${databaseName}`;
}

export function loadDataMigrationEnvironmentFiles(cwd = process.cwd()): void {
  loadEnvironmentFiles([
    resolve(cwd, '.env.migration'),
    resolve(cwd, '.env.neo'),
    resolve(cwd, '.env'),
  ]);
}

export function parseDataMigrationConfig(
  source: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): DataMigrationConfig {
  const primaryDatabase = databaseIdentifier(
    source.MIGRATION_MYSQL_PRIMARY_DATABASE?.trim() || 'amazon_asin_monitor',
    'MIGRATION_MYSQL_PRIMARY_DATABASE',
  );
  const competitorDatabase = databaseIdentifier(
    source.MIGRATION_MYSQL_COMPETITOR_DATABASE?.trim() ||
      'amazon_competitor_monitor',
    'MIGRATION_MYSQL_COMPETITOR_DATABASE',
  );
  if (primaryDatabase === competitorDatabase) {
    throw new DataMigrationError(
      'MIGRATION_CONFIG_INVALID',
      'config.mysql_databases',
      'primary and competitor MySQL databases must be different',
    );
  }

  const primaryUrl = required(source, 'DATABASE_URL');
  const competitorUrl = required(source, 'COMPETITOR_DATABASE_URL');
  if (
    postgresTargetIdentity(primaryUrl, 'DATABASE_URL') ===
    postgresTargetIdentity(competitorUrl, 'COMPETITOR_DATABASE_URL')
  ) {
    throw new DataMigrationError(
      'MIGRATION_CONFIG_INVALID',
      'config.postgres_databases',
      'primary and competitor PostgreSQL databases must be different',
    );
  }

  return Object.freeze({
    mysql: Object.freeze({
      host: required(source, 'MIGRATION_MYSQL_HOST'),
      port: integerSetting(source, 'MIGRATION_MYSQL_PORT', 3306, 1, 65_535),
      user: required(source, 'MIGRATION_MYSQL_USER'),
      password: source.MIGRATION_MYSQL_PASSWORD ?? '',
      primaryDatabase,
      competitorDatabase,
    }),
    postgres: Object.freeze({ primaryUrl, competitorUrl }),
    batchSize: integerSetting(source, 'MIGRATION_BATCH_SIZE', 500, 1, 1_000),
    sampleSize: integerSetting(source, 'MIGRATION_SAMPLE_SIZE', 20, 0, 100),
    allowTargetReset: trueValues.has(
      source.MIGRATION_ALLOW_TARGET_RESET?.trim().toLowerCase() ?? '',
    ),
    reportPath: resolve(
      cwd,
      source.MIGRATION_REPORT_PATH?.trim() ||
        'artifacts/data-migration/report.json',
    ),
  });
}
