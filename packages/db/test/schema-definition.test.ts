import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  monitorHistoryOperationalIndexNames,
  timescaleAggregateProjectionViewNames,
  timescaleContinuousAggregateViewNames,
  timescaleStoragePolicy,
} from '../src/timescale';
import {
  competitorDrizzleTables,
  competitorTableNames,
  drizzleTableNames,
  primaryDrizzleTables,
  primaryTableNames,
} from './schema-fixtures';

const workspaceRoot = resolve(__dirname, '../../..');
const read = (relativePath: string) =>
  readFileSync(resolve(workspaceRoot, relativePath), 'utf8');
const baselinePath = 'packages/db/migrations/0000_baseline.sql';
const timescaleMigrationPath =
  'packages/db/migrations/0001_timescale_aggregates.sql';
const storagePolicyMigrationPath =
  'packages/db/migrations/0002_timescale_storage_policies.sql';
const storagePolicyRollbackPath =
  'packages/db/migrations/0002_timescale_storage_policies.rollback.sql';

describe('PostgreSQL 双库 Schema 基线', () => {
  it('Drizzle 事实源覆盖 Legacy 最终态 21 + 4 张表', () => {
    expect(drizzleTableNames(primaryDrizzleTables)).toEqual([
      ...primaryTableNames,
    ]);
    expect(drizzleTableNames(competitorDrizzleTables)).toEqual([
      ...competitorTableNames,
    ]);
  });

  it('单一 baseline 通过 psql 连接双库且表集合完整', () => {
    const baseline = read(baselinePath);
    const createdTables = [
      ...baseline.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)/g),
    ]
      .map((match) => match[1])
      .sort();

    expect(createdTables).toEqual(
      [...primaryTableNames, ...competitorTableNames].sort(),
    );
    expect(baseline).toContain('\\connect :primary_database');
    expect(baseline).toContain('\\connect :competitor_database');
  });

  it('逐项消除 MySQL 专用语法并落地既定 PG 类型映射', () => {
    const baseline = read(baselinePath);

    for (const forbidden of [
      /`/,
      /\bTINYINT\b/i,
      /\bENUM\s*\(/i,
      /\bAUTO_INCREMENT\b/i,
      /\bON DUPLICATE KEY\b/i,
      /\bENGINE\s*=/i,
      /^\s*USE\s+/im,
    ]) {
      expect(baseline).not.toMatch(forbidden);
    }

    expect(baseline.match(/\bCHECK\s*\(/g)).toHaveLength(5);
    expect(baseline.match(/GENERATED ALWAYS AS IDENTITY/g)).toHaveLength(12);
    expect(baseline.match(/GENERATED ALWAYS AS \(date_trunc\(/g)).toHaveLength(
      3,
    );
    expect(baseline).toContain('timestamp without time zone');
    expect(baseline).not.toMatch(/timestamp\s+with\s+time\s+zone/i);
    expect(baseline).toContain(
      `ALTER DATABASE :"primary_database" SET timezone TO 'Asia/Shanghai'`,
    );
    expect(baseline).toContain(
      `ALTER DATABASE :"competitor_database" SET timezone TO 'Asia/Shanghai'`,
    );
    expect(baseline.match(/SET TIME ZONE 'Asia\/Shanghai'/g)).toHaveLength(2);
    expect(baseline.match(/\bjsonb\b/g)).toHaveLength(3);
    expect(baseline).toContain('set_updated_timestamp_column');
    expect(baseline).toContain('TG_ARGV[0]');
    expect(baseline).toContain(
      'ON CONFLICT (role_id, permission_id) DO NOTHING',
    );
    expect(baseline).toContain('EXCLUDED.description');
    expect(baseline).toContain(
      'idx_monitor_history_month_country_asin ON monitor_history (month_ts, country, asin_id, asin_code, is_broken)',
    );
  });

  it('Legacy 33 个迁移文件保持历史冻结', () => {
    const migrationFiles = readdirSync(
      resolve(workspaceRoot, 'server/database/migrations'),
    ).filter((file) => file.endsWith('.sql'));
    const migrationGuide = read('server/database/MIGRATION.md');

    expect(migrationFiles).toHaveLength(33);
    expect(migrationGuide).toContain('历史冻结');
    expect(migrationGuide).toContain(baselinePath);
  });

  it('有序升级将历史表转换为 7 天 hypertable 并保留 Legacy 聚合 Gate', () => {
    const migration = read(timescaleMigrationPath);

    expect(
      migration.indexOf('SET search_path TO pg_catalog, public;'),
    ).toBeLessThan(migration.indexOf('BEGIN;'));
    expect(migration).toContain("by_range('check_time', INTERVAL '7 days')");
    expect(migration).toContain('migrate_data => true');
    expect(migration).toContain(
      'ADD CONSTRAINT monitor_history_pkey PRIMARY KEY (check_time, id)',
    );
    expect(migration).not.toMatch(
      /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?public\.monitor_history_agg/i,
    );
    expect(migration).not.toMatch(
      /DROP\s+TABLE[^;]*analytics_refresh_watermark/i,
    );
  });

  it('九个 CAGG 显式 materialized-only、WITH NO DATA 并配置刷新策略', () => {
    const migration = read(timescaleMigrationPath);
    const createdCaggs = [
      ...migration.matchAll(
        /CREATE MATERIALIZED VIEW IF NOT EXISTS public\.([a-z0-9_]+)/g,
      ),
    ].map((match) => match[1]);

    expect(createdCaggs).toEqual([...timescaleContinuousAggregateViewNames]);
    expect(
      migration.match(/timescaledb\.materialized_only = true/g),
    ).toHaveLength(18);
    expect(migration.match(/WITH NO DATA;/g)).toHaveLength(9);
    expect(migration.match(/add_continuous_aggregate_policy\(/g)).toHaveLength(
      9,
    );
    expect(migration.match(/if_not_exists => true/g)).toHaveLength(9);
    expect(migration.match(/timezone => 'Asia\/Shanghai'/g)).toHaveLength(9);
    expect(migration.match(/end_offset => INTERVAL '0'/g)).toHaveLength(9);
    expect(migration).toContain(
      'CREATE COLLATION IF NOT EXISTS public.legacy_utf8mb4_unicode_ci',
    );
    expect(migration).toContain("locale = 'und-u-ks-level1'");
    expect(migration).toContain('deterministic = false');
    expect(
      migration.match(/COLLATE public\.legacy_utf8mb4_unicode_ci/g)?.length,
    ).toBeGreaterThanOrEqual(60);
    expect(migration.match(/rtrim\(/g)?.length).toBeGreaterThanOrEqual(80);
    expect(
      migration.match(/LEFT JOIN public\.variant_groups variant_group/g),
    ).toHaveLength(3);
    expect(migration).toContain(
      'amazon-asin-monitor:cagg-definition:p1-t4a-v2:md5:',
    );
    expect(migration).toContain('expected_definitions constant jsonb');
    expect(migration).toContain('asin_monitor.cagg_expected_definitions');
    expect(migration).toContain(
      'continuous aggregate definition fingerprint mismatch',
    );
    expect(migration).toContain(
      'continuous aggregate declared definition fingerprint mismatch',
    );
  });

  it('CAGG 与兼容投影视图只暴露只读元数据，不伪装成 Drizzle 表', () => {
    const migration = read(timescaleMigrationPath);
    for (const viewName of timescaleAggregateProjectionViewNames) {
      expect(migration).toContain(`VIEW public.${viewName} AS`);
      expect(primaryTableNames).not.toContain(viewName);
    }
    for (const caggName of timescaleContinuousAggregateViewNames) {
      expect(primaryTableNames).not.toContain(caggName);
    }
  });

  it('P1-T4b 以分 chunk 事务把 19 个 Legacy 索引收敛为 7 个运维索引', () => {
    const migration = read(storagePolicyMigrationPath);

    for (const indexName of monitorHistoryOperationalIndexNames) {
      expect(migration).toContain(indexName);
    }
    expect(migration.match(/timescaledb\.transaction_per_chunk/g)).toHaveLength(
      36,
    );
    expect(
      migration.match(/CREATE INDEX IF NOT EXISTS idx_cagg_[a-z0-9_]+/g),
    ).toHaveLength(30);
    expect(
      migration.match(
        /DROP INDEX IF EXISTS public\.idx_monitor_history_[a-z0-9_]+;/g,
      ),
    ).toHaveLength(18);
    expect(migration).toContain(
      'WHERE is_broken = true AND notification_sent = false',
    );
    expect(migration).not.toContain('DESC NULLS LAST');
    expect(migration).toContain('ARRAY[0, 3, 3]::smallint[]');
    expect(migration).toContain('WHERE NOT indisprimary');
    expect(migration).toContain('index_row.indisunique');
    expect(migration).toContain('index_row.indnkeyatts');
    expect(migration).toContain('index_row.indnatts');
    expect(migration).toContain('index_row.indpred');
    expect(migration).toContain('unnest(index_row.indoption)');
    expect(migration).toContain(
      'continuous aggregate index inventory mismatch',
    );
    expect(migration).not.toMatch(/USING\s+brin/i);
  });

  it('P1-T4b 使用 2.29.2 columnstore API、精确 job Gate 与默认关闭 retention', () => {
    const migration = read(storagePolicyMigrationPath);

    expect(migration).toContain(
      `extension_version IS DISTINCT FROM '${timescaleStoragePolicy.extensionVersion}'`,
    );
    expect(migration.match(/timescaledb\.enable_columnstore,/g)).toHaveLength(
      10,
    );
    expect(migration.match(/CALL add_columnstore_policy\(/g)).toHaveLength(10);
    expect(migration).not.toContain('add_compression_policy(');
    expect(migration).toContain("jobs.proc_name = 'policy_compression'");
    expect(migration).toContain(
      'timescaledb_information.hypertable_columnstore_settings',
    );
    expect(migration).toContain('asin_monitor.monitor_history_retention_days');
    expect(migration).toContain(
      `retention_days < ${timescaleStoragePolicy.rawRetentionMinimumDays}`,
    );
    expect(migration).toContain("jobs.proc_name = 'policy_retention'");
    expect(migration).toContain(
      'retention must remain disabled when no explicit retention days are configured',
    );

    const rollback = read(storagePolicyRollbackPath);
    expect(rollback).not.toContain("relation.relname LIKE 'idx_cagg_%'");
    expect(rollback.match(/'idx_cagg_[a-z0-9_]+'/g)).toHaveLength(30);

    const rootPackage = JSON.parse(read('package.json')) as {
      scripts: Record<string, string>;
    };
    expect(rootPackage.scripts['db:upgrade:timescale-storage']).toContain(
      'exec -e TIMESCALE_RETENTION_DAYS -T timescaledb',
    );
  });
});
