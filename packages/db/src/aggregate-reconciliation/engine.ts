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
type PairedNormalizedRow = Record<string, string | boolean | null>;

interface AggregatePairQuery {
  readonly sql: string;
  readonly keyColumns: readonly string[];
  readonly valueColumns: readonly string[];
}

interface AggregateScanResult {
  readonly rows: string;
  readonly groups: string;
  readonly groupDigest: string;
  readonly valueDigest: string;
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
            ? `COALESCE(aggregate_row.variant_group_name_snapshot, '')::text AS variant_group_name`
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

function aggregatePairQuery(
  family: AggregateFamily,
  legacyRelation: string,
  caggRelation: string,
): AggregatePairQuery {
  const legacyProjection = normalizedSelect(family, false);
  const caggProjection = normalizedSelect(family, true);
  const legacyName = quoteIdentifier(legacyRelation);
  const caggName = quoteIdentifier(caggRelation);
  const valueColumns =
    family === 'variant_group'
      ? [...legacyProjection.keys, 'variant_group_name', ...commonValueColumns]
      : [...legacyProjection.keys, ...commonValueColumns];
  const joinConditions = legacyProjection.keys
    .map((column) => {
      const identifier = quoteIdentifier(column);
      return column === 'time_slot'
        ? `legacy_rows.${identifier} = cagg_rows.${identifier}`
        : `legacy_rows.${identifier} COLLATE public.legacy_utf8mb4_unicode_ci = cagg_rows.${identifier} COLLATE public.legacy_utf8mb4_unicode_ci`;
    })
    .join('\n        AND ');
  const canonicalKeyProjection = legacyProjection.keys.flatMap((column) => {
    const identifier = quoteIdentifier(column);
    const common = `LEAST(legacy_rows.${identifier} COLLATE "C", cagg_rows.${identifier} COLLATE "C")`;
    return [
      `CASE WHEN legacy_rows.time_slot IS NOT NULL AND cagg_rows.time_slot IS NOT NULL THEN ${common} ELSE legacy_rows.${identifier} COLLATE "C" END AS ${quoteIdentifier(
        `legacy_${column}`,
      )}`,
      `CASE WHEN legacy_rows.time_slot IS NOT NULL AND cagg_rows.time_slot IS NOT NULL THEN ${common} ELSE cagg_rows.${identifier} COLLATE "C" END AS ${quoteIdentifier(
        `cagg_${column}`,
      )}`,
    ];
  });
  const canonicalVariantNameProjection =
    family === 'variant_group'
      ? [
          `CASE
            WHEN legacy_rows.time_slot IS NOT NULL
              AND cagg_rows.time_slot IS NOT NULL
              AND legacy_rows.variant_group_name COLLATE public.legacy_utf8mb4_unicode_ci = cagg_rows.variant_group_name COLLATE public.legacy_utf8mb4_unicode_ci
              THEN LEAST(legacy_rows.variant_group_name COLLATE "C", cagg_rows.variant_group_name COLLATE "C")
            ELSE legacy_rows.variant_group_name COLLATE "C"
          END AS legacy_variant_group_name`,
          `CASE
            WHEN legacy_rows.time_slot IS NOT NULL
              AND cagg_rows.time_slot IS NOT NULL
              AND legacy_rows.variant_group_name COLLATE public.legacy_utf8mb4_unicode_ci = cagg_rows.variant_group_name COLLATE public.legacy_utf8mb4_unicode_ci
              THEN LEAST(legacy_rows.variant_group_name COLLATE "C", cagg_rows.variant_group_name COLLATE "C")
            ELSE cagg_rows.variant_group_name COLLATE "C"
          END AS cagg_variant_group_name`,
        ]
      : [];
  const commonValueProjection = commonValueColumns.flatMap((column) => {
    const identifier = quoteIdentifier(column);
    return [
      `legacy_rows.${identifier} AS ${quoteIdentifier(`legacy_${column}`)}`,
      `cagg_rows.${identifier} AS ${quoteIdentifier(`cagg_${column}`)}`,
    ];
  });
  const orderBy = legacyProjection.keys
    .flatMap((column) => {
      const identifier = quoteIdentifier(column);
      if (column === 'time_slot') {
        return [
          `COALESCE(legacy_rows.${identifier} COLLATE "C", cagg_rows.${identifier} COLLATE "C")`,
        ];
      }
      return [
        `COALESCE(legacy_rows.${identifier} COLLATE public.legacy_utf8mb4_unicode_ci, cagg_rows.${identifier} COLLATE public.legacy_utf8mb4_unicode_ci)`,
        `COALESCE(legacy_rows.${identifier} COLLATE "C", cagg_rows.${identifier} COLLATE "C")`,
      ];
    })
    .join(', ');
  return {
    keyColumns: legacyProjection.keys,
    valueColumns,
    sql: `
      WITH legacy_rows AS (
        SELECT
          ${legacyProjection.select}
        FROM public.${legacyName} aggregate_row
        WHERE aggregate_row.time_slot >= $1::timestamp
          AND aggregate_row.time_slot < $2::timestamp
          AND aggregate_row.granularity = $3
      ), cagg_rows AS (
        SELECT
          ${caggProjection.select}
        FROM public.${caggName} aggregate_row
        WHERE aggregate_row.time_slot >= $1::timestamp
          AND aggregate_row.time_slot < $2::timestamp
      )
      SELECT
        legacy_rows.time_slot IS NOT NULL AS legacy_present,
        cagg_rows.time_slot IS NOT NULL AS cagg_present,
        ${[
          ...canonicalKeyProjection,
          ...canonicalVariantNameProjection,
          ...commonValueProjection,
        ].join(',\n        ')}
      FROM legacy_rows
      FULL OUTER JOIN cagg_rows
        ON ${joinConditions}
      ORDER BY ${orderBy}
    `,
  };
}

function digestColumns(
  row: PairedNormalizedRow,
  prefix: 'legacy' | 'cagg',
  columns: readonly string[],
): string[] {
  return columns.map((column) => {
    const value = row[`${prefix}_${column}`];
    if (typeof value !== 'string') {
      throw new DataMigrationError(
        'AGGREGATE_ROW_INVALID',
        'aggregate.reconciliation.row',
        'aggregate reconciliation returned an invalid normalized row',
      );
    }
    return value;
  });
}

async function scanAggregatePair(
  client: PoolClient,
  query: AggregatePairQuery,
  config: TimescaleAggregateConfig,
  granularity: AggregateGranularity,
): Promise<{
  readonly legacy: AggregateScanResult;
  readonly cagg: AggregateScanResult;
}> {
  const cursorName = 'aggregate_reconciliation_cursor';
  const digests = {
    legacy: { group: new OrderedDigest(), value: new OrderedDigest() },
    cagg: { group: new OrderedDigest(), value: new OrderedDigest() },
  } as const;
  let cursorOpen = false;
  try {
    await client.query(
      `DECLARE ${cursorName} NO SCROLL CURSOR FOR ${query.sql}`,
      [config.windowStart, config.windowEnd, granularity],
    );
    cursorOpen = true;
    while (true) {
      const result = await client.query<PairedNormalizedRow>(
        `FETCH FORWARD ${config.pageSize} FROM ${cursorName}`,
      );
      for (const row of result.rows) {
        for (const side of ['legacy', 'cagg'] as const) {
          if (row[`${side}_present`] !== true) continue;
          digests[side].group.add(digestColumns(row, side, query.keyColumns));
          digests[side].value.add(digestColumns(row, side, query.valueColumns));
        }
      }
      if (result.rows.length < config.pageSize) break;
    }
  } finally {
    if (cursorOpen) {
      await client.query(`CLOSE ${cursorName}`).catch(() => undefined);
    }
  }
  const result = (side: 'legacy' | 'cagg'): AggregateScanResult => {
    const groups = digests[side].group.result();
    const values = digests[side].value.result();
    return {
      rows: values.count,
      groups: groups.count,
      groupDigest: groups.digest,
      valueDigest: values.digest,
    };
  };
  return { legacy: result('legacy'), cagg: result('cagg') };
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
      `CALL public.refresh_continuous_aggregate($1::regclass, $2::timestamp, $3::timestamp)`,
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
    await client.query('SET search_path TO pg_catalog, public');
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
        const { legacy, cagg } = await scanAggregatePair(
          client,
          aggregatePairQuery(
            evidence.family,
            evidence.legacyRelation,
            evidence.caggRelation,
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

    const checksMatch = checks.every(({ status }) => status === 'passed');
    const hasEvidence = checks.some(({ legacyRows }) => legacyRows !== '0');
    const failure = !checksMatch
      ? {
          code: 'AGGREGATE_RECONCILIATION_MISMATCH',
          scope: 'aggregate.reconciliation',
        }
      : !hasEvidence
      ? {
          code: 'AGGREGATE_RECONCILIATION_EMPTY_WINDOW',
          scope: 'aggregate.reconciliation',
        }
      : !config.refresh
      ? {
          code: 'AGGREGATE_REFRESH_REQUIRED',
          scope: 'aggregate.refresh',
        }
      : undefined;
    const passed = failure === undefined;
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
      ...(failure ? { failure } : {}),
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
