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
          `rtrim(aggregate_row.site::text) AS site`,
          `rtrim(aggregate_row.brand::text) AS brand`,
        ]
      : [
          `rtrim(aggregate_row.variant_group_id::text) AS variant_group_id`,
          cagg
            ? `rtrim(COALESCE(aggregate_row.variant_group_name_snapshot, '')::text) AS variant_group_name`
            : `rtrim(aggregate_row.variant_group_name::text) AS variant_group_name`,
        ];
  return {
    keys,
    select: [
      `to_char(aggregate_row.time_slot, 'YYYY-MM-DD HH24:MI:SS.US') AS time_slot`,
      `rtrim(aggregate_row.country::text) AS country`,
      ...familyColumns,
      `rtrim(aggregate_row.asin_key::text) AS asin_key`,
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
    definition_matches: boolean | null;
    marker_matches: boolean | null;
  }>(`
    WITH expected_definition (view_name, definition_fingerprint) AS (
      VALUES
        ('monitor_history_cagg_asin_day', '1b7e82e30be65a827df91d5aa5b040c9'),
        ('monitor_history_cagg_asin_hour', 'c8fbca31141d9ff2fd87bb2bc27a23da'),
        ('monitor_history_cagg_asin_month', 'b7e5ab6f505add599994843dafe1b1e2'),
        ('monitor_history_cagg_dim_day', 'f77caf1fe9c24ced94d2e3248847ef3f'),
        ('monitor_history_cagg_dim_hour', 'fd463ab0f4fd3ee1984f43864b8bd130'),
        ('monitor_history_cagg_dim_month', '37c470c8fe8198ada8aeb2b7f3fd6066'),
        ('monitor_history_cagg_variant_group_day', '5ab32fcf37370bc31d3c5940d31c7b38'),
        ('monitor_history_cagg_variant_group_hour', '188e2199865d8f41489bdc08f02ee4b9'),
        ('monitor_history_cagg_variant_group_month', 'd23ff17c43d69097626a6232a37b725b')
    )
    SELECT
      aggregate_row.view_name,
      aggregate_row.materialized_only,
      md5(regexp_replace(
        aggregate_row.view_definition,
        '[[:space:]]+',
        ' ',
        'g'
      )) = expected_definition.definition_fingerprint AS definition_matches,
      obj_description(
        format(
          '%I.%I',
          aggregate_row.view_schema,
          aggregate_row.view_name
        )::regclass,
        'pg_class'
      ) =
        'amazon-asin-monitor:cagg-definition:p1-t4a-v2:md5:' ||
        expected_definition.definition_fingerprint AS marker_matches
    FROM timescaledb_information.continuous_aggregates aggregate_row
    LEFT JOIN expected_definition
      ON expected_definition.view_name = aggregate_row.view_name
    WHERE aggregate_row.view_schema = 'public'
    ORDER BY aggregate_row.view_name
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
  if (
    result.rows.some(
      ({ definition_matches, marker_matches }) =>
        definition_matches !== true || marker_matches !== true,
    )
  ) {
    throw new DataMigrationError(
      'AGGREGATE_TARGET_DEFINITION_MISMATCH',
      'aggregate.target.cagg_definitions',
      'aggregate target CAGG definitions do not match migration-owned fingerprints',
    );
  }

  const policies = await client.query<{
    view_name: string;
    policy_present: boolean;
    schedule_interval_matches: boolean | null;
    start_offset_matches: boolean | null;
    end_offset_matches: boolean | null;
    scheduled_matches: boolean | null;
    fixed_schedule_matches: boolean | null;
    initial_start_matches: boolean | null;
    timezone_matches: boolean | null;
  }>(`
    WITH expected_policy (
      view_name,
      start_offset,
      end_offset,
      schedule_interval
    ) AS (
      VALUES
        ('monitor_history_cagg_asin_hour', INTERVAL '49 hours', INTERVAL '0', INTERVAL '10 minutes'),
        ('monitor_history_cagg_dim_hour', INTERVAL '49 hours', INTERVAL '0', INTERVAL '10 minutes'),
        ('monitor_history_cagg_variant_group_hour', INTERVAL '49 hours', INTERVAL '0', INTERVAL '10 minutes'),
        ('monitor_history_cagg_asin_day', INTERVAL '32 days', INTERVAL '0', INTERVAL '1 hour'),
        ('monitor_history_cagg_dim_day', INTERVAL '32 days', INTERVAL '0', INTERVAL '1 hour'),
        ('monitor_history_cagg_variant_group_day', INTERVAL '32 days', INTERVAL '0', INTERVAL '1 hour'),
        ('monitor_history_cagg_asin_month', INTERVAL '25 months', INTERVAL '0', INTERVAL '1 day'),
        ('monitor_history_cagg_dim_month', INTERVAL '25 months', INTERVAL '0', INTERVAL '1 day'),
        ('monitor_history_cagg_variant_group_month', INTERVAL '25 months', INTERVAL '0', INTERVAL '1 day')
    ), selected_materialization AS (
      SELECT
        expected_policy.*,
        hypertable.id AS materialization_hypertable_id
      FROM expected_policy
      JOIN timescaledb_information.continuous_aggregates aggregate_row
        ON aggregate_row.view_schema = 'public'
       AND aggregate_row.view_name = expected_policy.view_name
      JOIN _timescaledb_catalog.hypertable hypertable
        ON hypertable.schema_name = aggregate_row.materialization_hypertable_schema
       AND hypertable.table_name = aggregate_row.materialization_hypertable_name
    )
    SELECT
      expected_policy.view_name,
      jobs.job_id IS NOT NULL AS policy_present,
      jobs.schedule_interval = expected_policy.schedule_interval
        AS schedule_interval_matches,
      (jobs.config ->> 'start_offset')::interval = expected_policy.start_offset
        AS start_offset_matches,
      (jobs.config ->> 'end_offset')::interval = expected_policy.end_offset
        AS end_offset_matches,
      jobs.scheduled IS TRUE AS scheduled_matches,
      jobs.fixed_schedule IS TRUE AS fixed_schedule_matches,
      jobs.initial_start = TIMESTAMPTZ '2026-01-01 00:00:00+08'
        AS initial_start_matches,
      catalog_job.timezone = 'Asia/Shanghai' AS timezone_matches
    FROM selected_materialization expected_policy
      LEFT JOIN timescaledb_information.jobs jobs
        ON jobs.proc_name = 'policy_refresh_continuous_aggregate'
       AND (jobs.config ->> 'mat_hypertable_id')::integer =
         expected_policy.materialization_hypertable_id
      LEFT JOIN _timescaledb_catalog.bgw_job catalog_job
        ON catalog_job.id = jobs.job_id
    ORDER BY expected_policy.view_name
  `);
  const policyFields = [
    'policy_present',
    'schedule_interval_matches',
    'start_offset_matches',
    'end_offset_matches',
    'scheduled_matches',
    'fixed_schedule_matches',
    'initial_start_matches',
    'timezone_matches',
  ] as const;
  const actualPolicyNames = policies.rows.map(({ view_name }) => view_name);
  const mismatches = policies.rows.flatMap((policy) => {
    const fields = policyFields.filter((field) => policy[field] !== true);
    return fields.length === 0
      ? []
      : [`${policy.view_name}:${fields.join(',')}`];
  });
  if (
    JSON.stringify(expected) !== JSON.stringify(actualPolicyNames) ||
    mismatches.length > 0
  ) {
    throw new DataMigrationError(
      'AGGREGATE_TARGET_POLICY_MISMATCH',
      'aggregate.target.policies',
      `aggregate target refresh-policy mismatch (relations ${
        JSON.stringify(expected) === JSON.stringify(actualPolicyNames)
          ? 'exact'
          : 'mismatch'
      }; fields ${mismatches.join(';') || 'unknown'})`,
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
      `CALL public.refresh_continuous_aggregate(
        $1::regclass,
        $2::timestamp,
        $3::timestamp,
        force => TRUE
      )`,
      [`public.${caggRelation}`, config.windowStart, config.windowEnd],
    );
    logger.info('timescale_aggregate.refreshed', {
      relation: caggRelation,
      windowStart: config.windowStart,
      windowEnd: config.windowEnd,
    });
  }
}

async function countRowsOutsideWindow(
  client: PoolClient,
  config: TimescaleAggregateConfig,
): Promise<string> {
  const result = await client.query<{ rows_outside_window: string }>(
    `
      SELECT (
        (
          SELECT COUNT(*)
          FROM public.monitor_history history
          WHERE rtrim(history.check_type) COLLATE public.legacy_utf8mb4_unicode_ci = 'ASIN'
            AND (
              history.asin_id IS NOT NULL
              OR NULLIF(rtrim(history.asin_code), '') IS NOT NULL
            )
            AND (
              history.check_time < $1::timestamp
              OR history.check_time >= $2::timestamp
            )
        ) + (
          SELECT COUNT(*)
          FROM public.monitor_history_agg aggregate_row
          WHERE aggregate_row.time_slot < $1::timestamp
             OR aggregate_row.time_slot >= $2::timestamp
        ) + (
          SELECT COUNT(*)
          FROM public.monitor_history_agg_dim aggregate_row
          WHERE aggregate_row.time_slot < $1::timestamp
             OR aggregate_row.time_slot >= $2::timestamp
        ) + (
          SELECT COUNT(*)
          FROM public.monitor_history_agg_variant_group aggregate_row
          WHERE aggregate_row.time_slot < $1::timestamp
             OR aggregate_row.time_slot >= $2::timestamp
        )
      )::text AS rows_outside_window
    `,
    [config.windowStart, config.windowEnd],
  );
  const rowsOutsideWindow = result.rows[0]?.rows_outside_window;
  if (!rowsOutsideWindow || !/^(0|[1-9]\d*)$/.test(rowsOutsideWindow)) {
    throw new DataMigrationError(
      'AGGREGATE_COVERAGE_INVALID',
      'aggregate.coverage',
      'aggregate coverage query returned an invalid row count',
    );
  }
  return rowsOutsideWindow;
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
    let rowsOutsideWindow = '0';
    try {
      rowsOutsideWindow = await countRowsOutsideWindow(client, config);
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
      : rowsOutsideWindow !== '0'
      ? {
          code: 'AGGREGATE_RECONCILIATION_INCOMPLETE_COVERAGE',
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
      coverage: {
        scope: 'all-migrated-aggregate-history',
        rowsOutsideWindow,
      },
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
