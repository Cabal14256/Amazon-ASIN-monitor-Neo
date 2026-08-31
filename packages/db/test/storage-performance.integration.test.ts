import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import type { Pool, QueryResultRow } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPgPool } from '../src/client';
import { monitorHistoryOperationalIndexNames } from '../src/timescale';

const integrationEnabled = process.env.RUN_INTEGRATION_TESTS === 'true';
const databaseUrl =
  process.env.DATABASE_URL ??
  'postgresql://postgres:neo_dev_only@127.0.0.1:5432/amazon_asin_monitor';
const fixtureRows = Math.max(
  720_000,
  Number.parseInt(process.env.TIMESCALE_PERFORMANCE_FIXTURE_ROWS ?? '', 10) ||
    720_000,
);
const benchmarkRuns = Math.max(
  5,
  Number.parseInt(process.env.TIMESCALE_PERFORMANCE_RUNS ?? '', 10) || 5,
);
const fixtureStart = '2040-01-01 00:00:00';
const fixtureMiddle = '2040-02-01 00:00:00';
const fixtureEnd = '2040-03-01 00:00:00';
const caggDimensionIndexEvidenceCount = 9;
const benchmarkFamilies = ['asin', 'dim', 'variant_group'] as const;
const benchmarkCaseCount = benchmarkFamilies.length * 2 * 3 * 2;
type BenchmarkFamily = (typeof benchmarkFamilies)[number];
const reportPath = resolve(
  fileURLToPath(new URL('../../../', import.meta.url)),
  'artifacts',
  'timescale-performance',
  'integration-report.json',
);

type ExplainEvidence = {
  query: string;
  expectedIndex: string;
  usedIndexes: string[];
  nodeTypes: string[];
  executionMs: number;
  sharedHitBlocks: number;
  sharedReadBlocks: number;
};

type TimingStats = {
  samples: number;
  p50Ms: number;
  p90Ms: number;
  p95Ms: number;
};

type BenchmarkEvidence = {
  case: string;
  family: BenchmarkFamily;
  window: 'cold' | 'hot';
  granularity: 'hour' | 'day' | 'month';
  filter:
    | 'all'
    | 'country-asin'
    | 'country-site-brand'
    | 'country-variant-group';
  raw: TimingStats;
  cagg: TimingStats;
  p95Speedup: number;
  correct: boolean;
  rawDigest: string;
  caggDigest: string;
};

type PerformanceReport = {
  schemaVersion: 2;
  generatedAt: string;
  database: { timescaleVersion: string | null };
  dataset: {
    profile: string;
    rows: number;
    start: string;
    end: string;
    countries: number;
    sites: number;
    brands: number;
    asins: number;
  };
  gate: {
    requiredP95Speedup: number;
    maximumConcurrentReadP95Ms: number;
    passed: boolean;
    failures: string[];
  };
  indexEvidence: ExplainEvidence[];
  benchmarks: BenchmarkEvidence[];
  storageRegression: {
    chunk: string | null;
    convertedToColumnstore: boolean;
    columnstoredCaggRelations: number;
    columnstoredCaggChunks: number;
    lateWriteVisible: boolean;
    sustainedWriteRows: number;
    analyticalReadDuringWriteMs: number | null;
    analyticalReadsDuringWrites: TimingStats | null;
  };
};

const report: PerformanceReport = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  database: { timescaleVersion: null },
  dataset: {
    profile:
      'deterministic-60-day-repeated-monitoring-operational-and-analytics-fixture',
    rows: fixtureRows,
    start: fixtureStart,
    end: fixtureEnd,
    countries: 6,
    sites: 3,
    brands: 4,
    asins: 24,
  },
  gate: {
    requiredP95Speedup: 3,
    maximumConcurrentReadP95Ms: 2_000,
    passed: false,
    failures: [],
  },
  indexEvidence: [],
  benchmarks: [],
  storageRegression: {
    chunk: null,
    convertedToColumnstore: false,
    columnstoredCaggRelations: 0,
    columnstoredCaggChunks: 0,
    lateWriteVisible: false,
    sustainedWriteRows: 0,
    analyticalReadDuringWriteMs: null,
    analyticalReadsDuringWrites: null,
  },
};

let pool: Pool;

function roundMilliseconds(value: number): number {
  return Number(value.toFixed(3));
}

function percentile(
  sorted: readonly number[],
  percentileValue: number,
): number {
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1),
  );
  return sorted[index] ?? Number.POSITIVE_INFINITY;
}

function timingStats(samples: readonly number[]): TimingStats {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    samples: sorted.length,
    p50Ms: roundMilliseconds(percentile(sorted, 0.5)),
    p90Ms: roundMilliseconds(percentile(sorted, 0.9)),
    p95Ms: roundMilliseconds(percentile(sorted, 0.95)),
  };
}

function normalizedRows(rows: readonly QueryResultRow[]): string {
  return JSON.stringify(
    rows.map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          key,
          value instanceof Date ? value.toISOString() : String(value),
        ]),
      ),
    ),
  );
}

async function timedQuery(
  text: string,
  values: readonly unknown[],
): Promise<{ rows: QueryResultRow[]; durationMs: number }> {
  const startedAt = performance.now();
  const result = await pool.query(text, [...values]);
  return {
    rows: result.rows,
    durationMs: performance.now() - startedAt,
  };
}

async function assertDisposablePerformanceDatabase(): Promise<void> {
  const expectedDatabase = String(
    process.env.TIMESCALE_PERFORMANCE_DISPOSABLE_DATABASE ?? '',
  ).trim();
  if (!expectedDatabase || !/(?:^|_)ci(?:_|$)/i.test(expectedDatabase)) {
    throw new Error(
      'TIMESCALE_PERFORMANCE_DISPOSABLE_DATABASE must explicitly name a disposable *_ci database',
    );
  }
  const current = await pool.query<{ database_name: string }>(
    'SELECT current_database() AS database_name',
  );
  if (current.rows[0]?.database_name !== expectedDatabase) {
    throw new Error(
      `refusing destructive performance fixture: connected database does not match ${expectedDatabase}`,
    );
  }
}

function collectExplainDetails(
  value: unknown,
  details: {
    usedIndexes: Set<string>;
    nodeTypes: Set<string>;
    sharedHitBlocks: number;
    sharedReadBlocks: number;
  },
): void {
  if (Array.isArray(value)) {
    for (const item of value) collectExplainDetails(item, details);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const record = value as Record<string, unknown>;
  if (typeof record['Index Name'] === 'string') {
    details.usedIndexes.add(record['Index Name']);
  }
  if (typeof record['Node Type'] === 'string') {
    details.nodeTypes.add(record['Node Type']);
  }
  if (typeof record['Shared Hit Blocks'] === 'number') {
    details.sharedHitBlocks = Math.max(
      details.sharedHitBlocks,
      record['Shared Hit Blocks'],
    );
  }
  if (typeof record['Shared Read Blocks'] === 'number') {
    details.sharedReadBlocks = Math.max(
      details.sharedReadBlocks,
      record['Shared Read Blocks'],
    );
  }
  for (const nested of Object.values(record)) {
    collectExplainDetails(nested, details);
  }
}

async function explainWithIndexGate(
  query: string,
  expectedIndex: string,
  text: string,
  values: readonly unknown[],
): Promise<ExplainEvidence> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // CI 强制关闭顺序扫描只用于稳定验证“索引能服务真实查询”；报告仍保留实际执行耗时与 buffers。
    await client.query('SET LOCAL enable_seqscan = off');
    const result = await client.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${text}`,
      [...values],
    );
    const explain = result.rows[0]?.['QUERY PLAN'] as unknown;
    const details = {
      usedIndexes: new Set<string>(),
      nodeTypes: new Set<string>(),
      sharedHitBlocks: 0,
      sharedReadBlocks: 0,
    };
    collectExplainDetails(explain, details);
    const root = Array.isArray(explain)
      ? (explain[0] as Record<string, unknown> | undefined)
      : undefined;
    const evidence: ExplainEvidence = {
      query,
      expectedIndex,
      usedIndexes: [...details.usedIndexes].sort(),
      nodeTypes: [...details.nodeTypes].sort(),
      executionMs: roundMilliseconds(Number(root?.['Execution Time'] ?? 0)),
      sharedHitBlocks: details.sharedHitBlocks,
      sharedReadBlocks: details.sharedReadBlocks,
    };
    const indexWasUsed = evidence.usedIndexes.some((indexName) => {
      const inheritedSuffix = indexName.includes('_chunk_')
        ? indexName.split('_chunk_').at(-1) ?? indexName
        : indexName;
      return (
        indexName.includes(expectedIndex) ||
        expectedIndex.startsWith(inheritedSuffix)
      );
    });
    if (!indexWasUsed) {
      report.gate.failures.push(
        `${query}: expected ${expectedIndex}, used ${
          evidence.usedIndexes.join(', ') || 'none'
        }`,
      );
    }
    expect(indexWasUsed).toBe(true);
    await client.query('ROLLBACK');
    return evidence;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

const aggregateIntervals = {
  hour: '1 hour',
  day: '1 day',
  month: '1 month',
} as const;

function familyRawPredicate(family: BenchmarkFamily): string {
  return family === 'variant_group' ? 'AND variant_group_id IS NOT NULL' : '';
}

function familyFilterPredicate(
  family: BenchmarkFamily,
  filtered: boolean,
): string {
  if (!filtered) return '';
  if (family === 'asin') {
    return "AND rtrim(country) = 'US' AND COALESCE(NULLIF(rtrim(asin_code), ''), 'ID#' || rtrim(asin_id)) = 'P000000001'";
  }
  if (family === 'variant_group') {
    return "AND rtrim(country) = 'US' AND rtrim(variant_group_id) = 'perf-group-0'";
  }
  return "AND rtrim(country) = 'US' AND rtrim(site_snapshot) = 'store-0' AND rtrim(brand_snapshot) = 'brand-0'";
}

function caggFilterPredicate(
  family: BenchmarkFamily,
  filtered: boolean,
): string {
  if (!filtered) return '';
  if (family === 'asin') {
    return "AND country = 'US' AND asin_key = 'P000000001'";
  }
  if (family === 'variant_group') {
    return "AND country = 'US' AND variant_group_id = 'perf-group-0'";
  }
  return "AND country = 'US' AND site = 'store-0' AND brand = 'brand-0'";
}

function benchmarkFilterName(
  family: BenchmarkFamily,
  filtered: boolean,
): BenchmarkEvidence['filter'] {
  if (!filtered) return 'all';
  if (family === 'asin') return 'country-asin';
  if (family === 'variant_group') return 'country-variant-group';
  return 'country-site-brand';
}

function rawAggregateQuery(family: BenchmarkFamily, filtered: boolean): string {
  return `
    SELECT
      to_char(time_bucket($1::interval, check_time), 'YYYY-MM-DD HH24:MI:SS') AS time_slot,
      rtrim(country) AS country,
      COUNT(*)::text AS check_count,
      COUNT(*) FILTER (WHERE is_broken IS TRUE)::text AS broken_count
    FROM public.monitor_history
    WHERE check_time >= $2::timestamp
      AND check_time < $3::timestamp
      AND rtrim(check_type) = 'ASIN'
      AND (asin_id IS NOT NULL OR NULLIF(rtrim(asin_code), '') IS NOT NULL)
      ${familyRawPredicate(family)}
      ${familyFilterPredicate(family, filtered)}
    GROUP BY 1, 2
    ORDER BY 1, 2
  `;
}

function caggAggregateQuery(
  family: BenchmarkFamily,
  granularity: keyof typeof aggregateIntervals,
  filtered: boolean,
): string {
  return `
    SELECT
      to_char(time_slot, 'YYYY-MM-DD HH24:MI:SS') AS time_slot,
      country AS country,
      SUM(check_count)::text AS check_count,
      SUM(broken_count)::text AS broken_count
    FROM public.monitor_history_cagg_${family}_${granularity}
    WHERE time_slot >= $1::timestamp
      AND time_slot < $2::timestamp
      ${caggFilterPredicate(family, filtered)}
    GROUP BY 1, 2
    ORDER BY 1, 2
  `;
}

async function assertManagedCaggDimensionIndexPlans(): Promise<void> {
  const dimensions = [
    { column: 'country', value: 'US' },
    { column: 'site', value: 'store-0' },
    { column: 'brand', value: 'brand-0' },
  ] as const;
  for (const granularity of ['hour', 'day', 'month'] as const) {
    for (const dimension of dimensions) {
      const expectedIndex = `idx_cagg_dim_${granularity}_${dimension.column}_time`;
      report.indexEvidence.push(
        await explainWithIndexGate(
          `cagg-dim-${granularity}-${dimension.column}`,
          expectedIndex,
          `SELECT SUM(check_count)::text
           FROM public.monitor_history_cagg_dim_${granularity}
           WHERE ${dimension.column} = $1
             AND time_slot >= $2::timestamp
             AND time_slot < $3::timestamp`,
          [dimension.value, fixtureStart, fixtureEnd],
        ),
      );
    }
  }
}

async function runBenchmarkCase(options: {
  family: BenchmarkFamily;
  window: 'cold' | 'hot';
  start: string;
  end: string;
  granularity: keyof typeof aggregateIntervals;
  filtered: boolean;
}): Promise<BenchmarkEvidence> {
  const rawSql = rawAggregateQuery(options.family, options.filtered);
  const caggSql = caggAggregateQuery(
    options.family,
    options.granularity,
    options.filtered,
  );
  const rawValues = [
    aggregateIntervals[options.granularity],
    options.start,
    options.end,
  ];
  const caggValues = [options.start, options.end];

  await timedQuery(rawSql, rawValues);
  await timedQuery(caggSql, caggValues);

  const rawSamples: number[] = [];
  const caggSamples: number[] = [];
  let rawRows: QueryResultRow[] = [];
  let caggRows: QueryResultRow[] = [];
  for (let run = 0; run < benchmarkRuns; run += 1) {
    const order = run % 2 === 0 ? ['raw', 'cagg'] : ['cagg', 'raw'];
    for (const target of order) {
      if (target === 'raw') {
        const result = await timedQuery(rawSql, rawValues);
        rawRows = result.rows;
        rawSamples.push(result.durationMs);
      } else {
        const result = await timedQuery(caggSql, caggValues);
        caggRows = result.rows;
        caggSamples.push(result.durationMs);
      }
    }
  }

  const normalizedRaw = normalizedRows(rawRows);
  const normalizedCagg = normalizedRows(caggRows);
  const correct = normalizedRaw === normalizedCagg;
  const filter = benchmarkFilterName(options.family, options.filtered);
  const caseName = `${options.window}-${options.family}-${options.granularity}-${filter}`;
  if (!correct) {
    report.gate.failures.push(`${caseName}: normalized result mismatch`);
  }

  const raw = timingStats(rawSamples);
  const cagg = timingStats(caggSamples);
  const p95Speedup = Number((raw.p95Ms / cagg.p95Ms).toFixed(3));
  if (p95Speedup < report.gate.requiredP95Speedup) {
    report.gate.failures.push(
      `${caseName}: P95 speedup ${p95Speedup}x is below ${report.gate.requiredP95Speedup}x`,
    );
  }
  return {
    case: caseName,
    family: options.family,
    window: options.window,
    granularity: options.granularity,
    filter,
    raw,
    cagg,
    p95Speedup,
    correct,
    rawDigest: createHash('sha256').update(normalizedRaw).digest('hex'),
    caggDigest: createHash('sha256').update(normalizedCagg).digest('hex'),
  };
}

async function convertFixtureCaggChunksToColumnstore(): Promise<void> {
  const chunks = await pool.query<{
    view_name: string;
    chunk: string;
    is_compressed: boolean;
  }>(
    `
      WITH selected_cagg AS (
        SELECT
          aggregate_row.view_name,
          aggregate_row.materialization_hypertable_schema AS hypertable_schema,
          aggregate_row.materialization_hypertable_name AS hypertable_name
        FROM timescaledb_information.continuous_aggregates aggregate_row
        WHERE aggregate_row.view_schema = 'public'
          AND aggregate_row.view_name = ANY($1::text[])
      )
      SELECT
        selected_cagg.view_name,
        format('%I.%I', chunk_row.chunk_schema, chunk_row.chunk_name) AS chunk,
        chunk_row.is_compressed
      FROM selected_cagg
      JOIN timescaledb_information.chunks chunk_row
        ON chunk_row.hypertable_schema = selected_cagg.hypertable_schema
       AND chunk_row.hypertable_name = selected_cagg.hypertable_name
      WHERE chunk_row.range_start < $2::timestamp
        AND chunk_row.range_end > $3::timestamp
      ORDER BY selected_cagg.view_name, chunk_row.range_start
    `,
    [
      [
        'monitor_history_cagg_asin_hour',
        'monitor_history_cagg_asin_day',
        'monitor_history_cagg_asin_month',
        'monitor_history_cagg_dim_hour',
        'monitor_history_cagg_dim_day',
        'monitor_history_cagg_dim_month',
        'monitor_history_cagg_variant_group_hour',
        'monitor_history_cagg_variant_group_day',
        'monitor_history_cagg_variant_group_month',
      ],
      fixtureEnd,
      fixtureStart,
    ],
  );
  expect(new Set(chunks.rows.map(({ view_name }) => view_name)).size).toBe(9);
  for (const { chunk, is_compressed } of chunks.rows) {
    if (!is_compressed) {
      await pool.query('CALL convert_to_columnstore($1::regclass)', [chunk]);
    }
  }

  const verified = await pool.query<{
    relation_count: number;
    chunk_count: number;
    all_columnstored: boolean;
  }>(
    `
      WITH selected_cagg AS (
        SELECT
          aggregate_row.view_name,
          aggregate_row.materialization_hypertable_schema AS hypertable_schema,
          aggregate_row.materialization_hypertable_name AS hypertable_name
        FROM timescaledb_information.continuous_aggregates aggregate_row
        WHERE aggregate_row.view_schema = 'public'
          AND aggregate_row.view_name = ANY($1::text[])
      )
      SELECT
        COUNT(DISTINCT selected_cagg.view_name)::integer AS relation_count,
        COUNT(*)::integer AS chunk_count,
        BOOL_AND(chunk_row.is_compressed) AS all_columnstored
      FROM selected_cagg
      JOIN timescaledb_information.chunks chunk_row
        ON chunk_row.hypertable_schema = selected_cagg.hypertable_schema
       AND chunk_row.hypertable_name = selected_cagg.hypertable_name
      WHERE chunk_row.range_start < $2::timestamp
        AND chunk_row.range_end > $3::timestamp
    `,
    [
      [
        'monitor_history_cagg_asin_hour',
        'monitor_history_cagg_asin_day',
        'monitor_history_cagg_asin_month',
        'monitor_history_cagg_dim_hour',
        'monitor_history_cagg_dim_day',
        'monitor_history_cagg_dim_month',
        'monitor_history_cagg_variant_group_hour',
        'monitor_history_cagg_variant_group_day',
        'monitor_history_cagg_variant_group_month',
      ],
      fixtureEnd,
      fixtureStart,
    ],
  );
  report.storageRegression.columnstoredCaggRelations =
    verified.rows[0]?.relation_count ?? 0;
  report.storageRegression.columnstoredCaggChunks =
    verified.rows[0]?.chunk_count ?? 0;
  expect(report.storageRegression.columnstoredCaggRelations).toBe(9);
  expect(
    report.storageRegression.columnstoredCaggChunks,
  ).toBeGreaterThanOrEqual(9);
  expect(verified.rows[0]?.all_columnstored).toBe(true);
}

async function writeReportAtomically(): Promise<void> {
  report.generatedAt = new Date().toISOString();
  const concurrentReadP95Ms =
    report.storageRegression.analyticalReadsDuringWrites?.p95Ms ?? null;
  const concurrentReadPassed =
    concurrentReadP95Ms !== null &&
    concurrentReadP95Ms < report.gate.maximumConcurrentReadP95Ms;
  if (!concurrentReadPassed) {
    const reason =
      concurrentReadP95Ms === null
        ? 'concurrent-write-read: missing analytical P95 evidence'
        : `concurrent-write-read: analytical P95 ${concurrentReadP95Ms}ms is not below ${report.gate.maximumConcurrentReadP95Ms}ms`;
    if (!report.gate.failures.includes(reason))
      report.gate.failures.push(reason);
  }
  report.gate.passed =
    report.gate.failures.length === 0 &&
    report.indexEvidence.length ===
      monitorHistoryOperationalIndexNames.length +
        caggDimensionIndexEvidenceCount &&
    report.benchmarks.length === benchmarkCaseCount &&
    report.storageRegression.convertedToColumnstore &&
    report.storageRegression.columnstoredCaggRelations === 9 &&
    report.storageRegression.columnstoredCaggChunks >= 9 &&
    report.storageRegression.lateWriteVisible &&
    report.storageRegression.sustainedWriteRows >= 2_500 &&
    report.storageRegression.analyticalReadsDuringWrites !== null &&
    report.storageRegression.analyticalReadDuringWriteMs !== null &&
    concurrentReadPassed;
  await mkdir(resolve(reportPath, '..'), { recursive: true });
  const temporaryPath = `${reportPath}.${process.pid}.tmp`;
  await writeFile(
    temporaryPath,
    `${JSON.stringify(report, null, 2)}\n`,
    'utf8',
  );
  await rename(temporaryPath, reportPath);
}

describe.skipIf(!integrationEnabled)(
  'P1-T4b Timescale storage and performance integration',
  () => {
    beforeAll(async () => {
      pool = createPgPool(databaseUrl, {
        max: 4,
        connectionTimeoutMillis: 10_000,
        idleTimeoutMillis: 1_000,
      });
      await assertDisposablePerformanceDatabase();
      const extension = await pool.query<{ extversion: string }>(`
        SELECT extversion
        FROM pg_extension
        WHERE extname = 'timescaledb'
      `);
      report.database.timescaleVersion = extension.rows[0]?.extversion ?? null;
      expect(report.database.timescaleVersion).toBe('2.29.2');

      await pool.query(
        `
          DELETE FROM public.monitor_history
          WHERE check_time >= $1::timestamp
            AND check_time < $2::timestamp
            AND asin_id LIKE 'perf-asin-%'
        `,
        [fixtureStart, fixtureEnd],
      );
      await pool.query(
        `
          INSERT INTO public.monitor_history (
            variant_group_id,
            variant_group_name,
            asin_id,
            asin_code,
            asin_name,
            site_snapshot,
            brand_snapshot,
            check_type,
            country,
            is_broken,
            check_time,
            check_result,
            notification_sent,
            create_time
          )
          SELECT
            'perf-group-' || ((series_id - 1) % 12),
            'Performance group ' || ((series_id - 1) % 12),
            'perf-asin-' || ((series_id - 1) % 24),
            'P' || lpad((((series_id - 1) % 24) + 1)::text, 9, '0'),
            'Performance ASIN ' || ((series_id - 1) % 24),
            'store-' || (((series_id - 1) % 24) % 3),
            'brand-' || (((series_id - 1) % 24) % 4),
            'ASIN',
            (ARRAY['US', 'UK', 'DE', 'FR', 'ES', 'IT'])[((series_id - 1) % 6) + 1],
            series_id % 11 = 0,
            $1::timestamp
              + (
                mod(((series_id - 1) / 24) * 345::bigint, 5184000)
                * INTERVAL '1 second'
              ),
            jsonb_build_object('fixture', 'P1-T4b', 'sequence', series_id),
            false,
            $1::timestamp
          FROM generate_series(1, $2::integer) AS fixture(series_id)
        `,
        [fixtureStart, fixtureRows],
      );
      await pool.query('ANALYZE public.monitor_history');

      for (const family of ['asin', 'dim', 'variant_group'] as const) {
        for (const granularity of ['hour', 'day', 'month'] as const) {
          await pool.query(
            `CALL refresh_continuous_aggregate(
              'public.monitor_history_cagg_${family}_${granularity}'::regclass,
              $1::timestamp,
              $2::timestamp
            )`,
            [fixtureStart, fixtureEnd],
          );
        }
      }
      await assertManagedCaggDimensionIndexPlans();
      await convertFixtureCaggChunksToColumnstore();
    }, 300_000);

    afterAll(async () => {
      await writeReportAtomically();
      await pool?.end();
    });

    it('uses each selected operational index in real EXPLAIN ANALYZE BUFFERS plans', async () => {
      const id = await pool.query<{ id: string }>(
        `
          SELECT id::text
          FROM public.monitor_history
          WHERE check_time >= $1::timestamp
            AND check_time < $2::timestamp
            AND asin_id LIKE 'perf-asin-%'
          LIMIT 1
        `,
        [fixtureStart, fixtureEnd],
      );
      const cases = [
        {
          query: 'history-by-id',
          index: 'idx_monitor_history_id_lookup',
          text: 'SELECT * FROM public.monitor_history WHERE id = $1::bigint',
          values: [id.rows[0]?.id],
        },
        {
          query: 'variant-group-cursor-page',
          index: 'idx_monitor_history_variant_group_time',
          text: `SELECT id FROM public.monitor_history
            WHERE variant_group_id = 'perf-group-0'
              AND check_time >= $1::timestamp AND check_time < $2::timestamp
            ORDER BY check_time DESC, id DESC LIMIT 100`,
          values: [fixtureStart, fixtureEnd],
        },
        {
          query: 'country-cursor-page',
          index: 'idx_monitor_history_country_time',
          text: `SELECT id FROM public.monitor_history
            WHERE country = 'US'
              AND check_time >= $1::timestamp AND check_time < $2::timestamp
            ORDER BY check_time DESC, id DESC LIMIT 100`,
          values: [fixtureStart, fixtureEnd],
        },
        {
          query: 'asin-code-country-history',
          index: 'idx_monitor_history_asin_code_country_time',
          text: `SELECT id FROM public.monitor_history
            WHERE asin_code = 'P000000001' AND country = 'US'
              AND check_time >= $1::timestamp AND check_time < $2::timestamp
            ORDER BY check_time DESC, id DESC LIMIT 100`,
          values: [fixtureStart, fixtureEnd],
        },
        {
          query: 'asin-id-country-history',
          index: 'idx_monitor_history_asin_country_time',
          text: `SELECT id FROM public.monitor_history
            WHERE asin_id = 'perf-asin-0' AND country = 'US'
              AND check_time >= $1::timestamp AND check_time < $2::timestamp
            ORDER BY check_time DESC, id DESC LIMIT 100`,
          values: [fixtureStart, fixtureEnd],
        },
        {
          query: 'status-interval-refresh',
          index: 'idx_monitor_history_status_interval_refresh',
          text: `SELECT id FROM public.monitor_history
            WHERE check_type = 'ASIN'
              AND check_time >= $1::timestamp AND check_time < $2::timestamp
            ORDER BY check_time, id LIMIT 100`,
          values: [fixtureStart, fixtureEnd],
        },
        {
          query: 'pending-notification-scan',
          index: 'idx_monitor_history_notification_pending',
          text: `SELECT id FROM public.monitor_history
            WHERE country = 'US' AND is_broken = true AND notification_sent = false
              AND check_time >= $1::timestamp AND check_time < $2::timestamp
            ORDER BY check_time, id LIMIT 100`,
          values: [fixtureStart, fixtureEnd],
        },
      ] as const;

      expect(cases.map(({ index }) => index).sort()).toEqual(
        [...monitorHistoryOperationalIndexNames].sort(),
      );
      for (const benchmarkCase of cases) {
        report.indexEvidence.push(
          await explainWithIndexGate(
            benchmarkCase.query,
            benchmarkCase.index,
            benchmarkCase.text,
            benchmarkCase.values,
          ),
        );
      }
    }, 120_000);

    it('benchmarks every columnstored CAGG family across cold/hot filtered and unfiltered hour/day/month cases', async () => {
      for (const window of [
        { name: 'cold' as const, start: fixtureStart, end: fixtureMiddle },
        { name: 'hot' as const, start: fixtureMiddle, end: fixtureEnd },
      ]) {
        for (const family of benchmarkFamilies) {
          for (const granularity of ['hour', 'day', 'month'] as const) {
            for (const filtered of [false, true]) {
              report.benchmarks.push(
                await runBenchmarkCase({
                  family,
                  window: window.name,
                  start: window.start,
                  end: window.end,
                  granularity,
                  filtered,
                }),
              );
            }
          }
        }
      }
      expect(report.benchmarks).toHaveLength(benchmarkCaseCount);
      expect(new Set(report.benchmarks.map(({ family }) => family))).toEqual(
        new Set(benchmarkFamilies),
      );
      expect(report.gate.failures).toEqual([]);
    }, 300_000);

    it('supports columnstore reads, late writes and analytical reads during sustained high-frequency writes', async () => {
      const chunkResult = await pool.query<{ chunk: string }>(
        `
          SELECT format('%I.%I', chunk_schema, chunk_name) AS chunk
          FROM timescaledb_information.chunks
          WHERE hypertable_schema = 'public'
            AND hypertable_name = 'monitor_history'
            AND range_start >= $1::timestamp
            AND range_end <= $2::timestamp
            AND is_compressed = false
          ORDER BY range_start
          LIMIT 1
        `,
        [fixtureStart, fixtureMiddle],
      );
      const chunk = chunkResult.rows[0]?.chunk;
      expect(chunk).toBeTruthy();
      report.storageRegression.chunk = chunk ?? null;

      await pool.query('CALL convert_to_columnstore($1::regclass)', [chunk]);
      const converted = await pool.query<{ is_compressed: boolean }>(
        `
          SELECT is_compressed
          FROM timescaledb_information.chunks
          WHERE format('%I.%I', chunk_schema, chunk_name) = $1
        `,
        [chunk],
      );
      report.storageRegression.convertedToColumnstore =
        converted.rows[0]?.is_compressed === true;
      expect(report.storageRegression.convertedToColumnstore).toBe(true);

      const chunkRange = await pool.query<{ range_start: string }>(
        `
          SELECT range_start::text
          FROM timescaledb_information.chunks
          WHERE format('%I.%I', chunk_schema, chunk_name) = $1
        `,
        [chunk],
      );
      const lateWrite = await pool.query<{ id: string }>(
        `
          INSERT INTO public.monitor_history (
            variant_group_id, variant_group_name, asin_id, asin_code,
            asin_name, site_snapshot, brand_snapshot, check_type, country,
            is_broken, check_time, check_result, notification_sent
          ) VALUES (
            'perf-group-late', 'Performance late group', 'perf-asin-late',
            'PLATE00001', 'Performance late ASIN', 'store-0', 'brand-0',
            'ASIN', 'US', false, $1::timestamp + INTERVAL '1 minute',
            '{"fixture":"P1-T4b-late-write"}'::jsonb, false
          )
          RETURNING id::text
        `,
        [chunkRange.rows[0]?.range_start],
      );
      const lateWriteVisible = await pool.query<{ visible: boolean }>(
        `SELECT EXISTS(
          SELECT 1 FROM public.monitor_history WHERE id = $1::bigint
        ) AS visible`,
        [lateWrite.rows[0]?.id],
      );
      report.storageRegression.lateWriteVisible =
        lateWriteVisible.rows[0]?.visible === true;
      expect(report.storageRegression.lateWriteVisible).toBe(true);
      await pool.query(
        'CALL convert_to_columnstore($1::regclass, recompress => true)',
        [chunk],
      );

      const writer = await pool.connect();
      try {
        const analyticalSamples: number[] = [];
        for (let batch = 0; batch < 10; batch += 1) {
          const [writeResult, analyticalRead] = await Promise.all([
            writer.query(
              `
                INSERT INTO public.monitor_history (
                  variant_group_id, asin_id, asin_code, check_type, country,
                  is_broken, check_time, notification_sent
                )
                SELECT
                  'perf-group-concurrent',
                  'perf-asin-concurrent',
                  'PCONCUR001',
                  'ASIN',
                  'US',
                  series_id % 11 = 0,
                  $1::timestamp - INTERVAL '5 minutes'
                    + (($2::integer * 250 + series_id) * INTERVAL '1 microsecond'),
                  false
                FROM generate_series(1, 250) AS write_fixture(series_id)
              `,
              [fixtureEnd, batch],
            ),
            timedQuery(
              `
                SELECT SUM(check_count)::text
                FROM public.monitor_history_cagg_dim_day
                WHERE time_slot >= $1::timestamp AND time_slot < $2::timestamp
              `,
              [fixtureMiddle, fixtureEnd],
            ),
          ]);
          report.storageRegression.sustainedWriteRows +=
            writeResult.rowCount ?? 0;
          analyticalSamples.push(analyticalRead.durationMs);
          expect(analyticalRead.rows[0]?.sum).toBeTruthy();
        }
        const concurrentReadStats = timingStats(analyticalSamples);
        report.storageRegression.analyticalReadsDuringWrites =
          concurrentReadStats;
        report.storageRegression.analyticalReadDuringWriteMs =
          concurrentReadStats.p95Ms;
        expect(report.storageRegression.sustainedWriteRows).toBe(2_500);
        expect(concurrentReadStats.samples).toBe(10);
        expect(concurrentReadStats.p95Ms).toBeLessThan(
          report.gate.maximumConcurrentReadP95Ms,
        );
      } catch (error) {
        throw error;
      } finally {
        writer.release();
      }
    }, 120_000);
  },
);
