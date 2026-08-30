import { createHash, randomUUID } from 'node:crypto';

import {
  timescaleAggregateEvidenceManifest,
  timescaleAggregateReportSchema,
  type TimescaleAggregateCheck,
  type TimescaleAggregateReport,
} from '@asin-monitor/contracts';
import type { PoolClient } from 'pg';

import { createPgPool } from '../client';
import { canonicalJson } from '../migration/canonical';
import { DataMigrationError } from '../migration/errors';
import type { MigrationLogger } from '../migration/logger';
import {
  validateTimescaleAggregateConfig,
  type TimescaleAggregateConfig,
} from './config';

type AggregateFamily = 'asin' | 'dimension' | 'variant_group';
type AggregateGranularity = 'hour' | 'day' | 'month';
type NormalizedRow = Record<string, string>;

interface AggregateQuery {
  readonly sql: string;
  readonly keyColumns: readonly string[];
  readonly valueColumns: readonly string[];
  readonly legacy: boolean;
}

export interface TimescaleAggregateRunMetadata {
  readonly runId?: string;
  readonly startedAt?: Date;
}

class OrderedDigest {
  private readonly hash = createHash('sha256');
  private entries = 0n;

  add(value: unknown): void {
    const canonical = canonicalJson(value);
    this.hash.update(`${Buffer.byteLength(canonical, 'utf8')}:`);
    this.hash.update(canonical, 'utf8');
    this.hash.update('\n');
    this.entries += 1n;
  }

  result(): { readonly count: string; readonly digest: string } {
    return { count: this.entries.toString(), digest: this.hash.digest('hex') };
  }
}

const commonValueColumns = [
  'check_count',
  'broken_count',
  'has_broken',
  'has_peak',
  'first_check_time',
  'last_check_time',
] as const;

function quoteIdentifier(value: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) {
    throw new DataMigrationError(
      'AGGREGATE_REGISTRY_INVALID',
      'aggregate.registry',
      'aggregate registry contains an unsafe identifier',
    );
  }
  return `"${value}"`;
}

function normalizedSelect(
  family: AggregateFamily,
  cagg: boolean,
): { readonly select: string; readonly keys: readonly string[] } {
  const keys =
    family === 'asin'
      ? ['time_slot', 'country', 'asin_key']
      : family === 'dimension'
      ? ['time_slot', 'country', 'site', 'brand', 'asin_key']
      : ['time_slot', 'country', 'variant_group_id', 'asin_key'];
  const familyColumns =
    family === 'asin'
      ? []
      : family === 'dimension'
      ? [
          `aggregate_row.site::text AS site`,
          `aggregate_row.brand::text AS brand`,
        ]
      : [
          `aggregate_row.variant_group_id::text AS variant_group_id`,
          cagg
            ? `COALESCE(aggregate_row.variant_group_name_snapshot, NULLIF(variant_group.name, ''), '')::text AS variant_group_name`
            : `aggregate_row.variant_group_name::text AS variant_group_name`,
        ];
  return {
    keys,
    select: [
      `to_char(aggregate_row.time_slot, 'YYYY-MM-DD HH24:MI:SS.US') AS time_slot`,
      `aggregate_row.country::text AS country`,
      ...familyColumns,
      `aggregate_row.asin_key::text AS asin_key`,
      `aggregate_row.check_count::text AS check_count`,
      `aggregate_row.broken_count::text AS broken_count`,
      `CASE WHEN aggregate_row.has_broken THEN '1' ELSE '0' END AS has_broken`,
      `CASE WHEN aggregate_row.has_peak THEN '1' ELSE '0' END AS has_peak`,
      `to_char(aggregate_row.first_check_time, 'YYYY-MM-DD HH24:MI:SS.US') AS first_check_time`,
      `to_char(aggregate_row.last_check_time, 'YYYY-MM-DD HH24:MI:SS.US') AS last_check_time`,
    ].join(',\n        '),
  };
}

function aggregateQuery(
  family: AggregateFamily,
  relation: string,
  legacy: boolean,
  pageSize: number,
): AggregateQuery {
  const projection = normalizedSelect(family, !legacy);
  const name = quoteIdentifier(relation);
  const join =
    family === 'variant_group' && !legacy
      ? `LEFT JOIN public.variant_groups variant_group\n          ON variant_group.id = aggregate_row.variant_group_id`
      : '';
  const granularityFilter = legacy ? `AND aggregate_row.granularity = $3` : '';
  const offsetParameter = legacy ? '$4' : '$3';
  const orderBy = projection.keys
    .map((column) => `${quoteIdentifier(column)} COLLATE "C"`)
    .join(', ');
  return {
    legacy,
    keyColumns: projection.keys,
    valueColumns:
      family === 'variant_group'
        ? [...projection.keys, 'variant_group_name', ...commonValueColumns]
        : [...projection.keys, ...commonValueColumns],
    sql: `
      SELECT
        ${projection.select}
      FROM public.${name} aggregate_row
      ${join}
      WHERE aggregate_row.time_slot >= $1::timestamp
        AND aggregate_row.time_slot < $2::timestamp
        ${granularityFilter}
      ORDER BY ${orderBy}
      LIMIT ${pageSize}
      OFFSET ${offsetParameter}::integer
    `,
  };
}

async function scanAggregate(
  client: PoolClient,
  query: AggregateQuery,
  config: TimescaleAggregateConfig,
  granularity: AggregateGranularity,
): Promise<{
  readonly rows: string;
  readonly groups: string;
  readonly groupDigest: string;
  readonly valueDigest: string;
}> {
  const groupDigest = new OrderedDigest();
  const valueDigest = new OrderedDigest();
  let offset = 0;
  while (true) {
    const parameters: unknown[] = [config.windowStart, config.windowEnd];
    if (query.legacy) parameters.push(granularity);
    parameters.push(offset);
    const result = await client.query<NormalizedRow>(query.sql, parameters);
    for (const row of result.rows) {
      groupDigest.add(query.keyColumns.map((column) => row[column]));
      valueDigest.add(query.valueColumns.map((column) => row[column]));
    }
    offset += result.rows.length;
    if (result.rows.length < config.pageSize) break;
  }
  const groups = groupDigest.result();
  const values = valueDigest.result();
  return {
    rows: values.count,
    groups: groups.count,
    groupDigest: groups.digest,
    valueDigest: values.digest,
  };
}

async function validateTarget(client: PoolClient): Promise<void> {
  const environment = await client.query<{
    encoding: string;
    timezone: string;
  }>(`
    SELECT
      pg_encoding_to_char(encoding) AS encoding,
      current_setting('TimeZone') AS timezone
    FROM pg_database
    WHERE datname = current_database()
  `);
  if (
    environment.rows.length !== 1 ||
    environment.rows[0]?.encoding !== 'UTF8' ||
    environment.rows[0]?.timezone !== 'Asia/Shanghai'
  ) {
    throw new DataMigrationError(
      'AGGREGATE_TARGET_ENVIRONMENT_MISMATCH',
      'aggregate.target.environment',
      'aggregate target must use UTF8 and Asia/Shanghai',
    );
  }

  const caggNames = timescaleAggregateEvidenceManifest.map(
    ({ caggRelation }) => caggRelation,
  );
  const result = await client.query<{
    view_name: string;
    materialized_only: boolean;
  }>(`
    SELECT view_name, materialized_only
    FROM timescaledb_information.continuous_aggregates
    WHERE view_schema = 'public'
    ORDER BY view_name
  `);
  const expected = [...caggNames].sort();
  const actual = result.rows.map(({ view_name }) => view_name).sort();
  if (
    JSON.stringify(expected) !== JSON.stringify(actual) ||
    result.rows.some(({ materialized_only }) => !materialized_only)
  ) {
    throw new DataMigrationError(
      'AGGREGATE_TARGET_SCHEMA_MISMATCH',
      'aggregate.target.caggs',
      'aggregate target does not contain the exact materialized-only CAGG set',
    );
  }
}

async function refreshAggregates(
  client: PoolClient,
  config: TimescaleAggregateConfig,
  logger: MigrationLogger,
): Promise<void> {
  for (const { caggRelation } of timescaleAggregateEvidenceManifest) {
    await client.query(
      `CALL refresh_continuous_aggregate($1::regclass, $2::timestamp, $3::timestamp)`,
      [`public.${caggRelation}`, config.windowStart, config.windowEnd],
    );
    logger.info('timescale_aggregate.refreshed', {
      relation: caggRelation,
      windowStart: config.windowStart,
      windowEnd: config.windowEnd,
    });
  }
}

export async function runTimescaleAggregateGate(
  requestedConfig: TimescaleAggregateConfig,
  logger: MigrationLogger,
  metadata: TimescaleAggregateRunMetadata = {},
): Promise<TimescaleAggregateReport> {
  const config = validateTimescaleAggregateConfig(requestedConfig);
  const runId = metadata.runId ?? randomUUID();
  const startedAt = metadata.startedAt ?? new Date();
  const pool = createPgPool(config.databaseUrl, {
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 1_000,
  });
  const client = await pool.connect();
  let advisoryLockHeld = false;
  try {
    const lock = await client.query<{ acquired: boolean }>(`
      SELECT pg_try_advisory_lock(
        hashtextextended('amazon-asin-monitor:p1-t4a-aggregate-gate', 0)
      ) AS acquired
    `);
    advisoryLockHeld = lock.rows[0]?.acquired === true;
    if (!advisoryLockHeld) {
      throw new DataMigrationError(
        'AGGREGATE_GATE_ALREADY_RUNNING',
        'aggregate.lock',
        'another aggregate gate is already running',
      );
    }
    await validateTarget(client);
    if (config.refresh) await refreshAggregates(client, config, logger);

    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const checks: TimescaleAggregateCheck[] = [];
    try {
      for (const evidence of timescaleAggregateEvidenceManifest) {
        const legacy = await scanAggregate(
          client,
          aggregateQuery(
            evidence.family,
            evidence.legacyRelation,
            true,
            config.pageSize,
          ),
          config,
          evidence.granularity,
        );
        const cagg = await scanAggregate(
          client,
          aggregateQuery(
            evidence.family,
            evidence.caggRelation,
            false,
            config.pageSize,
          ),
          config,
          evidence.granularity,
        );
        const passed =
          legacy.rows === cagg.rows &&
          legacy.groups === cagg.groups &&
          legacy.groupDigest === cagg.groupDigest &&
          legacy.valueDigest === cagg.valueDigest;
        checks.push({
          ...evidence,
          legacyRows: legacy.rows,
          caggRows: cagg.rows,
          legacyGroups: legacy.groups,
          caggGroups: cagg.groups,
          legacyGroupDigest: legacy.groupDigest,
          caggGroupDigest: cagg.groupDigest,
          legacyValueDigest: legacy.valueDigest,
          caggValueDigest: cagg.valueDigest,
          status: passed ? 'passed' : 'failed',
        });
        logger.info('timescale_aggregate.reconciled', {
          family: evidence.family,
          granularity: evidence.granularity,
          legacyRows: legacy.rows,
          caggRows: cagg.rows,
          status: passed ? 'passed' : 'failed',
        });
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    }

    const passed = checks.every(({ status }) => status === 'passed');
    return timescaleAggregateReportSchema.parse({
      schemaVersion: 1,
      runId,
      strategy: 'legacy-cagg-window-reconciliation',
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      window: {
        start: config.windowStart,
        end: config.windowEnd,
        boundary: '[start,end)',
        timezone: 'Asia/Shanghai',
      },
      refreshRequested: config.refresh,
      checks,
      status: passed ? 'passed' : 'failed',
      ...(passed
        ? {}
        : {
            failure: {
              code: 'AGGREGATE_RECONCILIATION_MISMATCH',
              scope: 'aggregate.reconciliation',
            },
          }),
    });
  } finally {
    if (advisoryLockHeld) {
      await client
        .query(
          `SELECT pg_advisory_unlock(
            hashtextextended('amazon-asin-monitor:p1-t4a-aggregate-gate', 0)
          )`,
        )
        .catch(() => undefined);
    }
    client.release();
    await pool.end();
  }
}
