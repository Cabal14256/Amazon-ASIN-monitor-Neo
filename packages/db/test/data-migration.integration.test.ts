import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { dataMigrationReportSchema } from '@asin-monitor/contracts';
import mysql, { type Connection } from 'mysql2/promise';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DataMigrationConfig } from '../src/migration/config';
import { runDataMigration } from '../src/migration/engine';
import {
  createMigrationLogger,
  type MigrationLogger,
} from '../src/migration/logger';

const integrationEnabled = process.env.RUN_INTEGRATION_TESTS === 'true';
const sourcePrimaryDatabase =
  process.env.INTEGRATION_MYSQL_DATABASE ?? 'amazon_asin_monitor_ci_local';
const sourceCompetitorDatabase =
  process.env.INTEGRATION_COMPETITOR_DATABASE ??
  'amazon_competitor_monitor_ci_local';
const primaryTargetUrl =
  process.env.DATABASE_URL ??
  'postgresql://postgres:neo_dev_only@127.0.0.1:5432/amazon_asin_monitor';
const competitorTargetUrl =
  process.env.COMPETITOR_DATABASE_URL ??
  'postgresql://postgres:neo_dev_only@127.0.0.1:5432/amazon_competitor_monitor';

let mysqlAdmin: Connection;
let primaryTarget: Pool;
let competitorTarget: Pool;

function safeIntegrationDatabase(name: string, expectedPrefix: string): string {
  if (!new RegExp(`^${expectedPrefix}_ci_[a-zA-Z0-9_]+$`).test(name)) {
    throw new Error(
      `integration database must start with ${expectedPrefix}_ci_`,
    );
  }
  return name;
}

function mysqlIdentifier(name: string): string {
  return `\`${name}\``;
}

function targetUrlWithShadowSearchPath(value: string): string {
  const url = new URL(value);
  url.searchParams.set('options', '-csearch_path=migration_shadow,public');
  return url.toString();
}

async function installLegacySchema(
  fileName: string,
  legacyDatabase: string,
  integrationDatabase: string,
): Promise<void> {
  const source = await readFile(
    resolve(__dirname, '../../../server/database', fileName),
    'utf8',
  );
  const rewritten = source.replaceAll(
    mysqlIdentifier(legacyDatabase),
    mysqlIdentifier(integrationDatabase),
  );
  await mysqlAdmin.query(rewritten);
}

async function seedPrimarySource(): Promise<void> {
  const connection = await mysql.createConnection({
    host: process.env.INTEGRATION_MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.INTEGRATION_MYSQL_PORT ?? 3306),
    user: process.env.INTEGRATION_MYSQL_USER ?? 'root',
    password: process.env.INTEGRATION_MYSQL_PASSWORD ?? '',
    database: sourcePrimaryDatabase,
    multipleStatements: true,
  });
  try {
    await connection.query(`
      CREATE TABLE mh_bak_20260828_123456 LIKE monitor_history;

      INSERT INTO variant_groups
        (id, name, country, site, brand, is_broken, manual_broken, is_competitor, feishu_notify_enabled, last_check_time)
      VALUES
        ('vg-ci-1', 'Integration Group', 'US', '12', 'Fixture Brand', 1, 1, 0, 1, '2026-08-28 09:10:11');

      INSERT INTO asins
        (id, asin, name, asin_type, country, site, brand, variant_group_id, is_broken, manual_broken, manual_excluded_from_group, feishu_notify_enabled, last_check_time)
      VALUES
        ('asin-ci-1', 'B000CI0001', 'Integration ASIN', 'MAIN_LINK', 'US', '12', 'Fixture Brand', 'vg-ci-1', 1, 0, 1, 1, '2026-08-28 09:10:11');

      INSERT INTO monitor_history
        (id, variant_group_id, variant_group_name, asin_id, asin_code, asin_name, site_snapshot, brand_snapshot, check_type, country, is_broken, check_time, check_result, notification_sent, create_time)
      VALUES
        (2, 'vg-ci-1', 'Integration Group', 'asin-ci-1', 'B000CI0001', 'Integration ASIN', '12', 'Fixture Brand', NULL, 'US', 0, '2026-08-28 09:08:11', NULL, 0, '2026-08-28 09:08:12'),
        (3, 'vg-ci-1', 'Integration Group', 'asin-ci-1', 'B000CI0001', 'Integration ASIN', '12', 'Fixture Brand', '', 'US', 0, '2026-08-28 09:09:11', NULL, 0, '2026-08-28 09:09:12'),
        (9007199254740993, 'vg-ci-1', 'Integration Group', 'asin-ci-1', 'B000CI0001', 'Integration ASIN', '12', 'Fixture Brand', 'ASIN', 'US', 1, '2026-08-28 09:10:11', '{"nested":{"b":2,"a":1},"large_id":9007199254740993}', 1, '2026-08-28 09:10:12');

      INSERT INTO monitor_history_agg
        (granularity, time_slot, country, asin_key, check_count, broken_count, has_broken, has_peak, first_check_time, last_check_time)
      VALUES
        ('hour', '2026-08-28 09:00:00', 'US', 'asin-ci-1', 2, 1, 1, 0, '2026-08-28 09:10:11', '2026-08-28 09:20:11'),
        ('hour', '2026-08-28 10:00:00', 'US', 'asin-ci-1', 1, 0, 0, 0, '2026-08-28 10:10:11', '2026-08-28 10:10:11'),
        ('day', '2026-08-28 00:00:00', 'US', 'asin-ci-1', 3, 1, 1, 1, '2026-08-28 09:10:11', '2026-08-28 10:10:11'),
        ('month', '2026-08-01 00:00:00', 'US', 'asin-ci-1', 3, 1, 1, 0, '2026-08-28 09:10:11', '2026-08-28 10:10:11');

      INSERT INTO monitor_history_agg_dim
        (granularity, time_slot, country, site, brand, asin_key, check_count, broken_count, has_broken, has_peak, first_check_time, last_check_time)
      VALUES
        ('hour', '2026-08-28 09:00:00', 'US', '12', 'Fixture Brand', 'asin-ci-1', 2, 1, 1, 0, '2026-08-28 09:10:11', '2026-08-28 09:20:11'),
        ('hour', '2026-08-28 10:00:00', 'US', '12', 'Fixture Brand', 'asin-ci-1', 1, 0, 0, 0, '2026-08-28 10:10:11', '2026-08-28 10:10:11'),
        ('day', '2026-08-28 00:00:00', 'US', '12', 'Fixture Brand', 'asin-ci-1', 3, 1, 1, 1, '2026-08-28 09:10:11', '2026-08-28 10:10:11'),
        ('month', '2026-08-01 00:00:00', 'US', '12', 'Fixture Brand', 'asin-ci-1', 3, 1, 1, 0, '2026-08-28 09:10:11', '2026-08-28 10:10:11');

      INSERT INTO monitor_history_agg_variant_group
        (granularity, time_slot, country, variant_group_id, variant_group_name, asin_key, check_count, broken_count, has_broken, has_peak, first_check_time, last_check_time)
      VALUES
        ('hour', '2026-08-28 09:00:00', 'US', 'vg-ci-1', 'Integration Group', 'asin-ci-1', 2, 1, 1, 0, '2026-08-28 09:10:11', '2026-08-28 09:20:11'),
        ('hour', '2026-08-28 10:00:00', 'US', 'vg-ci-1', 'Integration Group', 'asin-ci-1', 1, 0, 0, 0, '2026-08-28 10:10:11', '2026-08-28 10:10:11'),
        ('day', '2026-08-28 00:00:00', 'US', 'vg-ci-1', 'Integration Group', 'asin-ci-1', 3, 1, 1, 1, '2026-08-28 09:10:11', '2026-08-28 10:10:11'),
        ('month', '2026-08-01 00:00:00', 'US', 'vg-ci-1', 'Integration Group', 'asin-ci-1', 3, 1, 1, 0, '2026-08-28 09:10:11', '2026-08-28 10:10:11');

      INSERT INTO analytics_refresh_watermark
        (processor_name, last_history_id, last_check_time)
      VALUES
        ('integration', 9007199254740993, '2026-08-28 09:10:11');

      INSERT INTO monitor_history_status_interval
        (asin_key, asin_id, asin_code, asin_name, country, variant_group_id, variant_group_name, interval_start, interval_end, is_broken)
      VALUES
        ('asin-ci-1', 'asin-ci-1', 'B000CI0001', 'Integration ASIN', 'US', 'vg-ci-1', 'Integration Group', '2026-08-28 09:10:11', NULL, 1);

      INSERT INTO feishu_config (country, webhook_url, enabled)
      VALUES ('US', 'https://example.invalid/integration-webhook', 0);

      INSERT INTO sp_api_config (config_key, config_value, description)
      VALUES ('integration_fixture', 'non-secret-fixture', 'integration fixture');

      INSERT INTO users
        (id, username, password, real_name, status, force_password_change, failed_login_attempts)
      VALUES
        ('user-ci-1', 'integration-user', 'non-secret-test-hash', 'Integration User', 'ACTIVE', 1, 0);

      INSERT INTO password_history (id, user_id, password_hash, created_at)
      VALUES (9007199254740994, 'user-ci-1', 'non-secret-history-hash', '2026-08-28 09:00:00');

      INSERT INTO login_attempts (id, username, ip_address, success, created_at)
      VALUES (9007199254740995, 'integration-user', '192.0.2.1', 1, '2026-08-28 09:01:00');

      INSERT INTO user_status_history
        (id, user_id, old_status, new_status, reason, changed_by, created_at)
      VALUES
        (9007199254740996, 'user-ci-1', 'PENDING', 'ACTIVE', 'integration fixture', 'user-ci-1', '2026-08-28 09:02:00');

      INSERT INTO sessions
        (id, user_id, user_agent, ip_address, status, remember_me, created_at, last_active_at, expires_at)
      VALUES
        ('00000000-0000-4000-8000-000000000001', 'user-ci-1', 'integration-agent', '192.0.2.1', 'ACTIVE', 1, '2026-08-28 09:03:00', '2026-08-28 09:04:00', '2026-08-29 09:03:00');

      INSERT INTO user_roles (id, user_id, role_id, create_time)
      VALUES (9007199254740997, 'user-ci-1', 'role-003', '2026-08-28 09:05:00');

      INSERT INTO audit_logs
        (id, user_id, username, action, resource, resource_id, method, path, request_data, response_status, create_time)
      VALUES
        (9007199254740998, 'user-ci-1', 'integration-user', 'UPDATE', 'asin', 'asin-ci-1', 'PATCH', '/integration/asins/asin-ci-1', '{"enabled":true,"labels":["a","b"]}', 200, '2026-08-28 09:06:00');

      ALTER TABLE monitor_history AUTO_INCREMENT = 9007199254741999;
    `);
  } finally {
    await connection.end();
  }
}

async function seedCompetitorSource(): Promise<void> {
  const connection = await mysql.createConnection({
    host: process.env.INTEGRATION_MYSQL_HOST ?? '127.0.0.1',
    port: Number(process.env.INTEGRATION_MYSQL_PORT ?? 3306),
    user: process.env.INTEGRATION_MYSQL_USER ?? 'root',
    password: process.env.INTEGRATION_MYSQL_PASSWORD ?? '',
    database: sourceCompetitorDatabase,
    multipleStatements: true,
  });
  try {
    await connection.query(`
      INSERT INTO competitor_variant_groups
        (id, name, country, brand, is_broken, feishu_notify_enabled, last_check_time)
      VALUES
        ('cvg-ci-1', 'Competitor Group', 'DE', 'Fixture Competitor', 0, 0, '2026-08-28 10:00:00');

      INSERT INTO competitor_asins
        (id, asin, name, asin_type, country, brand, variant_group_id, is_broken, feishu_notify_enabled, last_check_time)
      VALUES
        ('casin-ci-1', 'B000CI0002', 'Competitor ASIN', 'MAIN_LINK', 'DE', 'Fixture Competitor', 'cvg-ci-1', 0, 0, '2026-08-28 10:00:00');

      INSERT INTO competitor_monitor_history
        (id, variant_group_id, variant_group_name, asin_id, asin_code, asin_name, check_type, country, is_broken, check_time, check_result, notification_sent, create_time)
      VALUES
        (9007199254740999, 'cvg-ci-1', 'Competitor Group', 'casin-ci-1', 'B000CI0002', 'Competitor ASIN', 'GROUP', 'DE', 0, '2026-08-28 10:00:00', '{"status":"ok"}', 0, '2026-08-28 10:00:01');

      INSERT INTO competitor_feishu_config (country, webhook_url, enabled)
      VALUES ('DE', 'https://example.invalid/competitor-webhook', 0);
    `);
  } finally {
    await connection.end();
  }
}

function reportEvidence(report: Awaited<ReturnType<typeof runDataMigration>>) {
  return report.databases.map((database) => ({
    logicalName: database.logicalName,
    tables: database.tables.map((table) => ({
      table: table.table,
      sourceRows: table.sourceRows,
      targetRows: table.targetRows,
      sampledRows: table.sampledRows,
      sourceSampleDigest: table.sourceSampleDigest,
      targetSampleDigest: table.targetSampleDigest,
      status: table.status,
    })),
    businessQueries: database.businessQueries,
    status: database.status,
  }));
}

describe.skipIf(!integrationEnabled)(
  'P1-T3 MySQL to PostgreSQL data migration integration',
  () => {
    const migrationConfig: DataMigrationConfig = {
      mysql: {
        host: process.env.INTEGRATION_MYSQL_HOST ?? '127.0.0.1',
        port: Number(process.env.INTEGRATION_MYSQL_PORT ?? 3306),
        user: process.env.INTEGRATION_MYSQL_USER ?? 'root',
        password: process.env.INTEGRATION_MYSQL_PASSWORD ?? '',
        primaryDatabase: sourcePrimaryDatabase,
        competitorDatabase: sourceCompetitorDatabase,
      },
      postgres: {
        primaryUrl: targetUrlWithShadowSearchPath(primaryTargetUrl),
        competitorUrl: targetUrlWithShadowSearchPath(competitorTargetUrl),
      },
      batchSize: 2,
      sampleSize: 20,
      allowTargetReset: true,
      reportPath: resolve('artifacts/data-migration/integration-report.json'),
    };
    const logger = createMigrationLogger('ERROR');

    beforeAll(async () => {
      if (process.env.INTEGRATION_ALLOW_DROP_DATABASES !== 'true') {
        throw new Error('INTEGRATION_ALLOW_DROP_DATABASES=true is required');
      }
      safeIntegrationDatabase(sourcePrimaryDatabase, 'amazon_asin_monitor');
      safeIntegrationDatabase(
        sourceCompetitorDatabase,
        'amazon_competitor_monitor',
      );
      mysqlAdmin = await mysql.createConnection({
        host: migrationConfig.mysql.host,
        port: migrationConfig.mysql.port,
        user: migrationConfig.mysql.user,
        password: migrationConfig.mysql.password,
        multipleStatements: true,
      });
      await mysqlAdmin.query(
        `DROP DATABASE IF EXISTS ${mysqlIdentifier(sourcePrimaryDatabase)}`,
      );
      await mysqlAdmin.query(
        `DROP DATABASE IF EXISTS ${mysqlIdentifier(sourceCompetitorDatabase)}`,
      );
      await installLegacySchema(
        'init.sql',
        'amazon_asin_monitor',
        sourcePrimaryDatabase,
      );
      await installLegacySchema(
        'competitor-init.sql',
        'amazon_competitor_monitor',
        sourceCompetitorDatabase,
      );
      await seedPrimarySource();
      await seedCompetitorSource();
      primaryTarget = new Pool({ connectionString: primaryTargetUrl, max: 1 });
      competitorTarget = new Pool({
        connectionString: competitorTargetUrl,
        max: 1,
      });
      await primaryTarget.query(`
        CREATE SCHEMA migration_shadow;
        CREATE TABLE migration_shadow.roles (
          id varchar(50) PRIMARY KEY,
          marker text NOT NULL
        );
        INSERT INTO migration_shadow.roles VALUES
          ('shadow-role', 'preserve'),
          ('role-003', 'foreign-key-fixture');
      `);
      await competitorTarget.query(`
        CREATE SCHEMA migration_shadow;
        CREATE TABLE migration_shadow.competitor_asins (
          id text PRIMARY KEY,
          marker text NOT NULL
        );
        INSERT INTO migration_shadow.competitor_asins
        VALUES ('shadow-asin', 'preserve');
      `);
    }, 30_000);

    afterAll(async () => {
      await Promise.allSettled([
        primaryTarget?.query('DROP SCHEMA migration_shadow CASCADE'),
        competitorTarget?.query('DROP SCHEMA migration_shadow CASCADE'),
      ]);
      await Promise.allSettled([primaryTarget?.end(), competitorTarget?.end()]);
      if (mysqlAdmin) {
        await mysqlAdmin.query(
          `DROP DATABASE IF EXISTS ${mysqlIdentifier(sourcePrimaryDatabase)}`,
        );
        await mysqlAdmin.query(
          `DROP DATABASE IF EXISTS ${mysqlIdentifier(
            sourceCompetitorDatabase,
          )}`,
        );
        await mysqlAdmin.end();
      }
    });

    it('未授权重置时不修改目标库', async () => {
      const before = await primaryTarget.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM roles',
      );
      await expect(
        runDataMigration(
          { ...migrationConfig, allowTargetReset: false },
          logger,
        ),
      ).rejects.toMatchObject({ code: 'TARGET_RESET_NOT_AUTHORIZED' });
      const after = await primaryTarget.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM roles',
      );
      expect(after.rows[0].count).toBe(before.rows[0].count);
    });

    it('目标约束漂移时在重置前拒绝迁移', async () => {
      await primaryTarget.query(
        'ALTER TABLE asins DROP CONSTRAINT uk_asins_asin_country',
      );
      try {
        await expect(
          runDataMigration(migrationConfig, logger),
        ).rejects.toMatchObject({
          code: 'TARGET_SCHEMA_MISMATCH',
          scope: 'primary.target.asins.constraints',
        });
      } finally {
        await primaryTarget.query(
          'ALTER TABLE asins ADD CONSTRAINT uk_asins_asin_country UNIQUE (asin, country)',
        );
      }
    });

    it('目标 CHECK 或索引定义漂移时在重置前拒绝迁移', async () => {
      await primaryTarget.query(`
        ALTER TABLE public.users DROP CONSTRAINT ck_users_status;
        ALTER TABLE public.users
          ADD CONSTRAINT ck_users_status CHECK (status <> 'INVALID');
      `);
      try {
        await expect(
          runDataMigration(migrationConfig, logger),
        ).rejects.toMatchObject({
          code: 'TARGET_SCHEMA_MISMATCH',
          scope: 'primary.target.users.constraints',
        });
      } finally {
        await primaryTarget.query(`
          ALTER TABLE public.users DROP CONSTRAINT ck_users_status;
          ALTER TABLE public.users
            ADD CONSTRAINT ck_users_status
            CHECK (status IN ('ACTIVE', 'INACTIVE', 'LOCKED', 'SUSPENDED', 'PENDING'));
        `);
      }

      await primaryTarget.query(`
        DROP INDEX public.idx_monitor_history_status_interval_refresh;
        CREATE INDEX idx_monitor_history_status_interval_refresh
          ON public.monitor_history (country);
      `);
      try {
        await expect(
          runDataMigration(migrationConfig, logger),
        ).rejects.toMatchObject({
          code: 'TARGET_SCHEMA_MISMATCH',
          scope: 'primary.target.monitor_history.indexes',
        });
      } finally {
        await primaryTarget.query(`
          DROP INDEX public.idx_monitor_history_status_interval_refresh;
          CREATE INDEX idx_monitor_history_status_interval_refresh
            ON public.monitor_history (check_type, check_time, id);
        `);
      }
    });

    it('目标外键改指向同名影子表时在重置前拒绝迁移', async () => {
      await primaryTarget.query(`
        ALTER TABLE public.user_roles DROP CONSTRAINT fk_user_roles_role;
        ALTER TABLE public.user_roles
          ADD CONSTRAINT fk_user_roles_role
          FOREIGN KEY (role_id)
          REFERENCES migration_shadow.roles(id)
          ON DELETE CASCADE;
      `);
      try {
        await expect(
          runDataMigration(migrationConfig, logger),
        ).rejects.toMatchObject({
          code: 'TARGET_SCHEMA_MISMATCH',
          scope: 'primary.target.user_roles.constraints',
        });
      } finally {
        await primaryTarget.query(`
          ALTER TABLE public.user_roles DROP CONSTRAINT fk_user_roles_role;
          ALTER TABLE public.user_roles
            ADD CONSTRAINT fk_user_roles_role
            FOREIGN KEY (role_id)
            REFERENCES public.roles(id)
            ON DELETE CASCADE;
        `);
      }
    });

    it('目标默认值、更新时间触发器或函数漂移时在重置前拒绝迁移', async () => {
      await primaryTarget.query(
        'ALTER TABLE public.users ALTER COLUMN force_password_change DROP DEFAULT',
      );
      try {
        await expect(
          runDataMigration(migrationConfig, logger),
        ).rejects.toMatchObject({
          code: 'TARGET_SCHEMA_MISMATCH',
          scope: 'primary.target.users.columns',
        });
      } finally {
        await primaryTarget.query(
          'ALTER TABLE public.users ALTER COLUMN force_password_change SET DEFAULT false',
        );
      }

      await primaryTarget.query(
        'DROP TRIGGER trg_users_update_time ON public.users',
      );
      try {
        await expect(
          runDataMigration(migrationConfig, logger),
        ).rejects.toMatchObject({
          code: 'TARGET_SCHEMA_MISMATCH',
          scope: 'primary.target.users.triggers',
        });
      } finally {
        await primaryTarget.query(`
          CREATE TRIGGER trg_users_update_time
          BEFORE UPDATE ON public.users
          FOR EACH ROW
          EXECUTE FUNCTION public.set_updated_timestamp_column('update_time')
        `);
      }

      await primaryTarget.query(`
        CREATE OR REPLACE FUNCTION public.set_updated_timestamp_column()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          RETURN NEW;
        END;
        $$
      `);
      try {
        await expect(
          runDataMigration(migrationConfig, logger),
        ).rejects.toMatchObject({
          code: 'TARGET_SCHEMA_MISMATCH',
          scope: 'primary.target.functions',
        });
      } finally {
        await primaryTarget.query(`
          CREATE OR REPLACE FUNCTION public.set_updated_timestamp_column()
          RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN
            CASE TG_ARGV[0]
              WHEN 'update_time' THEN NEW.update_time := LOCALTIMESTAMP;
              WHEN 'updated_at' THEN NEW.updated_at := LOCALTIMESTAMP;
              ELSE
                RAISE EXCEPTION 'unsupported timestamp column: %', TG_ARGV[0]
                  USING ERRCODE = '22023';
            END CASE;
            RETURN NEW;
          END;
          $$
        `);
      }
    });

    it('拒绝跨 schema 级联重置并保留外部引用数据', async () => {
      await primaryTarget.query(`
        CREATE SCHEMA migration_external;
        CREATE TABLE migration_external.role_refs (
          id integer PRIMARY KEY,
          role_id varchar(50) NOT NULL REFERENCES public.roles(id)
        );
        INSERT INTO migration_external.role_refs VALUES (1, 'role-003');
      `);
      try {
        await expect(
          runDataMigration(migrationConfig, logger),
        ).rejects.toMatchObject({ code: 'UNEXPECTED_MIGRATION_ERROR' });
        const preserved = await primaryTarget.query<{ count: string }>(
          'SELECT COUNT(*)::text AS count FROM migration_external.role_refs',
        );
        expect(preserved.rows[0].count).toBe('1');
      } finally {
        await primaryTarget.query('DROP SCHEMA migration_external CASCADE');
      }
    });

    it('普通失败回滚数据和事务化 sequence restart', async () => {
      await primaryTarget.query(`
        ALTER SEQUENCE public.monitor_history_id_seq RESTART WITH 7777;
      `);
      const beforeSequence = await primaryTarget.query<{
        last_value: string;
        is_called: boolean;
      }>(
        'SELECT last_value::text, is_called FROM public.monitor_history_id_seq',
      );
      const beforeRoles = await primaryTarget.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM public.roles',
      );
      const rollbackLogger: MigrationLogger = {
        ...logger,
        info(event, context) {
          if (
            event === 'data_migration.table_finished' &&
            context?.database === 'primary' &&
            context.table === 'monitor_history'
          ) {
            throw new Error(
              'integration fixture interrupts after sequence reset',
            );
          }
          logger.info(event, context);
        },
      };
      await expect(
        runDataMigration(migrationConfig, rollbackLogger),
      ).rejects.toMatchObject({ code: 'UNEXPECTED_MIGRATION_ERROR' });
      const afterSequence = await primaryTarget.query<{
        last_value: string;
        is_called: boolean;
      }>(
        'SELECT last_value::text, is_called FROM public.monitor_history_id_seq',
      );
      const afterRoles = await primaryTarget.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM public.roles',
      );
      expect(afterSequence.rows[0]).toEqual(beforeSequence.rows[0]);
      expect(afterRoles.rows[0]).toEqual(beforeRoles.rows[0]);
    });

    it('连续两次迁移 21 + 4 表且行数、样本和关键业务查询一致', async () => {
      const first = await runDataMigration(migrationConfig, logger);
      const second = await runDataMigration(migrationConfig, logger);

      expect(dataMigrationReportSchema.parse(first).status).toBe('passed');
      expect(dataMigrationReportSchema.parse(second).status).toBe('passed');
      expect(first.databases.map(({ tables }) => tables.length)).toEqual([
        21, 4,
      ]);
      expect(reportEvidence(second)).toEqual(reportEvidence(first));
      expect(
        second.databases
          .flatMap(({ tables }) => tables)
          .every(
            (table) =>
              table.status === 'passed' &&
              table.sourceRows === table.targetRows &&
              table.sourceSampleDigest === table.targetSampleDigest,
          ),
      ).toBe(true);
      expect(
        second.databases.flatMap(({ businessQueries }) => businessQueries),
      ).toHaveLength(7);
      const shadowPrimary = await primaryTarget.query<{ marker: string }>(
        'SELECT marker FROM migration_shadow.roles WHERE id = $1',
        ['shadow-role'],
      );
      const shadowCompetitor = await competitorTarget.query<{
        marker: string;
      }>('SELECT marker FROM migration_shadow.competitor_asins WHERE id = $1', [
        'shadow-asin',
      ]);
      expect(shadowPrimary.rows[0]?.marker).toBe('preserve');
      expect(shadowCompetitor.rows[0]?.marker).toBe('preserve');
    }, 60_000);

    it('保留 bigint、D8 时间、生成列、JSONB 和布尔值并重置 identity', async () => {
      const migrated = await primaryTarget.query<{
        id: string;
        is_broken: boolean;
        check_time: string;
        hour_ts: string;
        check_result: { nested: { a: number; b: number } };
        large_json_id: string;
        notification_sent: boolean;
      }>(`
        SELECT
          id::text,
          is_broken,
          to_char(check_time, 'YYYY-MM-DD HH24:MI:SS') AS check_time,
          to_char(hour_ts, 'YYYY-MM-DD HH24:MI:SS') AS hour_ts,
          check_result - 'large_id' AS check_result,
          check_result ->> 'large_id' AS large_json_id,
          notification_sent
        FROM monitor_history
        WHERE id = 9007199254740993
      `);
      expect(migrated.rows[0]).toEqual({
        id: '9007199254740993',
        is_broken: true,
        check_time: '2026-08-28 09:10:11',
        hour_ts: '2026-08-28 09:00:00',
        check_result: { nested: { a: 1, b: 2 } },
        large_json_id: '9007199254740993',
        notification_sent: true,
      });

      const nextIdentity = await primaryTarget.query<{ id: string }>(`
        INSERT INTO monitor_history (country, is_broken, check_time, notification_sent)
        VALUES ('US', false, '2026-08-28 11:00:00', false)
        RETURNING id::text
      `);
      expect(BigInt(nextIdentity.rows[0].id)).toBe(9007199254741999n);
    });
  },
);
