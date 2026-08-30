import { afterAll, describe, expect, it } from 'vitest';

import { loadEnvironmentFiles } from '@asin-monitor/config';

import { createPgPool } from '../src/client';
import {
  timescaleAggregateProjectionViewNames,
  timescaleContinuousAggregateViewNames,
} from '../src/timescale';
import {
  competitorDrizzleTables,
  competitorTableNames,
  drizzleColumnKeys,
  drizzleIndexNames,
  primaryDrizzleTables,
  primaryTableNames,
} from './schema-fixtures';

loadEnvironmentFiles();

const primaryPool = createPgPool(
  process.env.DATABASE_URL ??
    'postgresql://postgres:neo_dev_only@127.0.0.1:5432/amazon_asin_monitor',
  { max: 2, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 1_000 },
);
const competitorPool = createPgPool(
  process.env.COMPETITOR_DATABASE_URL ??
    'postgresql://postgres:neo_dev_only@127.0.0.1:5432/amazon_competitor_monitor',
  { max: 2, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 1_000 },
);

afterAll(async () => {
  await Promise.all([primaryPool.end(), competitorPool.end()]);
});

async function publicTableNames(
  pool: ReturnType<typeof createPgPool>,
): Promise<string[]> {
  const result = await pool.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  return result.rows.map(({ table_name }) => table_name);
}

async function publicColumnKeys(
  pool: ReturnType<typeof createPgPool>,
  tables: readonly string[],
): Promise<string[]> {
  const result = await pool.query<{ table_name: string; column_name: string }>(
    `
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
      ORDER BY table_name, column_name
    `,
    [tables],
  );
  return result.rows
    .map(({ table_name, column_name }) => `${table_name}.${column_name}`)
    .sort();
}

async function existingIndexNames(
  pool: ReturnType<typeof createPgPool>,
  expectedNames: string[],
): Promise<string[]> {
  const result = await pool.query<{ indexname: string }>(
    `
      SELECT indexname
      FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname = ANY($1::text[])
      ORDER BY indexname
    `,
    [expectedNames],
  );
  return result.rows.map(({ indexname }) => indexname);
}

async function uniqueConstraintNames(
  pool: ReturnType<typeof createPgPool>,
): Promise<string[]> {
  const result = await pool.query<{ conname: string }>(`
    SELECT conname
    FROM pg_constraint
    WHERE contype = 'u'
      AND connamespace = 'public'::regnamespace
    ORDER BY conname
  `);
  return result.rows.map(({ conname }) => conname);
}

describe('P1-T2 PostgreSQL schema integration', () => {
  it('双库的数据库级与当前会话时区均固定为 Asia/Shanghai', async () => {
    for (const pool of [primaryPool, competitorPool]) {
      const sessionTimezone = await pool.query<{ TimeZone: string }>(
        'SHOW TIME ZONE',
      );
      expect(sessionTimezone.rows[0].TimeZone).toBe('Asia/Shanghai');

      const databaseTimezone = await pool.query<{ setting: string | null }>(`
        SELECT split_part(config, '=', 2) AS setting
        FROM pg_db_role_setting settings
        CROSS JOIN LATERAL unnest(settings.setconfig) AS config
        WHERE settings.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())
          AND settings.setrole = 0
          AND config LIKE 'TimeZone=%'
      `);
      expect(databaseTimezone.rows).toContainEqual({
        setting: 'Asia/Shanghai',
      });
    }
  });

  it('真实双库表与 Drizzle 21 + 4 表、全部列和显式索引一致', async () => {
    expect(await publicTableNames(primaryPool)).toEqual([...primaryTableNames]);
    expect(await publicTableNames(competitorPool)).toEqual([
      ...competitorTableNames,
    ]);

    expect(await publicColumnKeys(primaryPool, primaryTableNames)).toEqual(
      drizzleColumnKeys(primaryDrizzleTables),
    );
    expect(
      await publicColumnKeys(competitorPool, competitorTableNames),
    ).toEqual(drizzleColumnKeys(competitorDrizzleTables));

    const primaryIndexes = drizzleIndexNames(primaryDrizzleTables);
    const competitorIndexes = drizzleIndexNames(competitorDrizzleTables);
    expect(await existingIndexNames(primaryPool, primaryIndexes)).toEqual(
      primaryIndexes,
    );
    expect(await existingIndexNames(competitorPool, competitorIndexes)).toEqual(
      competitorIndexes,
    );

    expect(await uniqueConstraintNames(primaryPool)).toEqual([
      'feishu_config_country_unique',
      'permissions_code_unique',
      'roles_code_unique',
      'sp_api_config_config_key_unique',
      'uk_asins_asin_country',
      'uk_role_permissions_role_permission',
      'uk_user_roles_user_role',
      'users_username_unique',
    ]);
    expect(await uniqueConstraintNames(competitorPool)).toEqual([
      'competitor_feishu_config_country_unique',
      'uk_competitor_asins_asin_country',
    ]);
  });

  it('monitor_history 是 7 天单时间维 hypertable 且复合主键包含分区键', async () => {
    const hypertable = await primaryPool.query<{
      hypertable_name: string;
      num_dimensions: number;
    }>(`
      SELECT hypertable_name, num_dimensions
      FROM timescaledb_information.hypertables
      WHERE hypertable_schema = 'public'
        AND hypertable_name = 'monitor_history'
    `);
    expect(hypertable.rows).toEqual([
      { hypertable_name: 'monitor_history', num_dimensions: 1 },
    ]);

    const dimension = await primaryPool.query<{
      column_name: string;
      dimension_type: string;
      time_interval: string;
    }>(`
      SELECT column_name, dimension_type, time_interval::text
      FROM timescaledb_information.dimensions
      WHERE hypertable_schema = 'public'
        AND hypertable_name = 'monitor_history'
    `);
    expect(dimension.rows).toEqual([
      {
        column_name: 'check_time',
        dimension_type: 'Time',
        time_interval: '7 days',
      },
    ]);

    const primaryKey = await primaryPool.query<{ columns: string[] }>(`
      SELECT ARRAY_AGG(attribute.attname::text ORDER BY key.position) AS columns
      FROM pg_constraint constraint_row
      CROSS JOIN LATERAL
        unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum, position)
      JOIN pg_attribute attribute
        ON attribute.attrelid = constraint_row.conrelid
       AND attribute.attnum = key.attnum
      WHERE constraint_row.conrelid = 'public.monitor_history'::regclass
        AND constraint_row.contype = 'p'
    `);
    expect(primaryKey.rows).toEqual([{ columns: ['check_time', 'id'] }]);

    const competitorHypertables = await competitorPool.query<{
      count: string;
    }>(`
      SELECT COUNT(*)::text AS count
      FROM timescaledb_information.hypertables
      WHERE hypertable_schema = 'public'
    `);
    expect(competitorHypertables.rows[0].count).toBe('0');
  });

  it('九个 CAGG 均为 materialized-only，三类只读投影视图和九条策略唯一', async () => {
    const aggregates = await primaryPool.query<{
      view_name: string;
      materialized_only: boolean;
    }>(`
      SELECT view_name, materialized_only
      FROM timescaledb_information.continuous_aggregates
      WHERE view_schema = 'public'
      ORDER BY view_name
    `);
    expect(aggregates.rows).toEqual(
      [...timescaleContinuousAggregateViewNames].sort().map((view_name) => ({
        view_name,
        materialized_only: true,
      })),
    );

    const projections = await primaryPool.query<{ table_name: string }>(
      `
      SELECT table_name
      FROM information_schema.views
      WHERE table_schema = 'public'
        AND table_name = ANY($1::text[])
      ORDER BY table_name
    `,
      [timescaleAggregateProjectionViewNames],
    );
    expect(projections.rows.map(({ table_name }) => table_name)).toEqual(
      [...timescaleAggregateProjectionViewNames].sort(),
    );

    const policies = await primaryPool.query<{
      schedule_interval: string;
      policy_count: string;
    }>(
      `
      WITH selected_materializations AS (
        SELECT
          materialization_hypertable_schema AS schema_name,
          materialization_hypertable_name AS table_name
        FROM timescaledb_information.continuous_aggregates
        WHERE view_schema = 'public'
          AND view_name = ANY($1::text[])
      ), selected_ids AS (
        SELECT hypertable.id
        FROM _timescaledb_catalog.hypertable hypertable
        JOIN selected_materializations materialization
          ON materialization.schema_name = hypertable.schema_name
         AND materialization.table_name = hypertable.table_name
      )
      SELECT jobs.schedule_interval::text, COUNT(*)::text AS policy_count
      FROM timescaledb_information.jobs jobs
      WHERE jobs.proc_name = 'policy_refresh_continuous_aggregate'
        AND (jobs.config ->> 'mat_hypertable_id')::integer IN (
          SELECT id FROM selected_ids
        )
      GROUP BY jobs.schedule_interval
      ORDER BY jobs.schedule_interval
    `,
      [timescaleContinuousAggregateViewNames],
    );
    expect(policies.rows).toEqual([
      { schedule_interval: '00:10:00', policy_count: '3' },
      { schedule_interval: '01:00:00', policy_count: '3' },
      { schedule_interval: '1 day', policy_count: '3' },
    ]);
  });

  it('PG 类型映射、identity、生成列与五个 CHECK 均生效', async () => {
    const columns = await primaryPool.query<{
      table_name: string;
      column_name: string;
      data_type: string;
      is_identity: string;
      identity_generation: string | null;
      is_generated: string;
      generation_expression: string | null;
    }>(`
      SELECT
        table_name,
        column_name,
        data_type,
        is_identity,
        identity_generation,
        is_generated,
        generation_expression
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (table_name, column_name) IN (
          ('variant_groups', 'is_broken'),
          ('users', 'force_password_change'),
          ('monitor_history', 'id'),
          ('monitor_history', 'check_time'),
          ('monitor_history', 'hour_ts'),
          ('monitor_history', 'day_ts'),
          ('monitor_history', 'month_ts'),
          ('monitor_history', 'check_result'),
          ('audit_logs', 'request_data'),
          ('users', 'status'),
          ('sessions', 'status')
        )
    `);
    const byKey = new Map(
      columns.rows.map((column) => [
        `${column.table_name}.${column.column_name}`,
        column,
      ]),
    );

    expect(byKey.get('variant_groups.is_broken')?.data_type).toBe('boolean');
    expect(byKey.get('users.force_password_change')?.data_type).toBe('boolean');
    expect(byKey.get('monitor_history.id')).toMatchObject({
      data_type: 'bigint',
      is_identity: 'YES',
      identity_generation: 'ALWAYS',
    });
    expect(byKey.get('monitor_history.check_time')?.data_type).toBe(
      'timestamp without time zone',
    );
    expect(byKey.get('monitor_history.check_result')?.data_type).toBe('jsonb');
    expect(byKey.get('audit_logs.request_data')?.data_type).toBe('jsonb');
    expect(byKey.get('users.status')?.data_type).toBe('character varying');
    expect(byKey.get('sessions.status')?.data_type).toBe('character varying');

    const competitorColumns = await competitorPool.query<{
      column_name: string;
      data_type: string;
      is_identity: string;
      identity_generation: string | null;
    }>(`
      SELECT column_name, data_type, is_identity, identity_generation
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'competitor_monitor_history'
        AND column_name IN ('id', 'check_result')
      ORDER BY column_name
    `);
    expect(competitorColumns.rows).toEqual([
      {
        column_name: 'check_result',
        data_type: 'jsonb',
        is_identity: 'NO',
        identity_generation: null,
      },
      {
        column_name: 'id',
        data_type: 'bigint',
        is_identity: 'YES',
        identity_generation: 'ALWAYS',
      },
    ]);

    for (const generatedColumn of ['hour_ts', 'day_ts', 'month_ts']) {
      const column = byKey.get(`monitor_history.${generatedColumn}`);
      expect(column?.data_type).toBe('timestamp without time zone');
      expect(column?.is_generated).toBe('ALWAYS');
      expect(column?.generation_expression).toContain('date_trunc');
    }

    const checks = await primaryPool.query<{ conname: string }>(`
      SELECT conname
      FROM pg_constraint
      WHERE contype = 'c'
        AND connamespace = 'public'::regnamespace
        AND conname IN (
          'ck_monitor_history_agg_granularity',
          'ck_monitor_history_agg_dim_granularity',
          'ck_monitor_history_agg_variant_group_granularity',
          'ck_users_status',
          'ck_sessions_status'
        )
      ORDER BY conname
    `);
    expect(checks.rows.map(({ conname }) => conname)).toEqual([
      'ck_monitor_history_agg_dim_granularity',
      'ck_monitor_history_agg_granularity',
      'ck_monitor_history_agg_variant_group_granularity',
      'ck_sessions_status',
      'ck_users_status',
    ]);
  });

  it('最终外键语义保留业务级联并移除历史快照外键', async () => {
    const primaryForeignKeys = await primaryPool.query<{
      table_name: string;
      conname: string;
      delete_action: string;
      update_action: string;
    }>(`
      SELECT
        relation.relname AS table_name,
        constraint_row.conname,
        constraint_row.confdeltype AS delete_action,
        constraint_row.confupdtype AS update_action
      FROM pg_constraint constraint_row
      JOIN pg_class relation ON relation.oid = constraint_row.conrelid
      WHERE constraint_row.contype = 'f'
        AND constraint_row.connamespace = 'public'::regnamespace
      ORDER BY relation.relname, constraint_row.conname
    `);
    expect(primaryForeignKeys.rows).toEqual([
      {
        table_name: 'asins',
        conname: 'fk_asins_variant_group',
        delete_action: 'c',
        update_action: 'a',
      },
      {
        table_name: 'password_history',
        conname: 'fk_password_history_user',
        delete_action: 'c',
        update_action: 'a',
      },
      {
        table_name: 'role_permissions',
        conname: 'fk_role_permissions_permission',
        delete_action: 'c',
        update_action: 'a',
      },
      {
        table_name: 'role_permissions',
        conname: 'fk_role_permissions_role',
        delete_action: 'c',
        update_action: 'a',
      },
      {
        table_name: 'sessions',
        conname: 'fk_sessions_user_id',
        delete_action: 'c',
        update_action: 'c',
      },
      {
        table_name: 'user_roles',
        conname: 'fk_user_roles_role',
        delete_action: 'c',
        update_action: 'a',
      },
      {
        table_name: 'user_roles',
        conname: 'fk_user_roles_user',
        delete_action: 'c',
        update_action: 'a',
      },
      {
        table_name: 'user_status_history',
        conname: 'fk_user_status_history_user',
        delete_action: 'c',
        update_action: 'a',
      },
    ]);

    const competitorForeignKeys = await competitorPool.query<{
      table_name: string;
      conname: string;
      delete_action: string;
    }>(`
      SELECT
        relation.relname AS table_name,
        constraint_row.conname,
        constraint_row.confdeltype AS delete_action
      FROM pg_constraint constraint_row
      JOIN pg_class relation ON relation.oid = constraint_row.conrelid
      WHERE constraint_row.contype = 'f'
        AND constraint_row.connamespace = 'public'::regnamespace
      ORDER BY relation.relname, constraint_row.conname
    `);
    expect(competitorForeignKeys.rows).toEqual([
      {
        table_name: 'competitor_asins',
        conname: 'fk_competitor_asins_variant_group',
        delete_action: 'c',
      },
    ]);
  });

  it('统一更新时间触发器、生成列与 CHECK 在写入路径真实工作', async () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const variantGroupId = `schema-trigger-${suffix}`.slice(0, 50);
    const invalidUserId = `schema-invalid-${suffix}`.slice(0, 50);

    try {
      const inserted = await primaryPool.query<{ update_time: Date }>(
        `
          INSERT INTO variant_groups (id, name, country, site, brand)
          VALUES ($1, 'before', 'US', 'schema-test', 'schema-test')
          RETURNING update_time
        `,
        [variantGroupId],
      );
      await primaryPool.query('SELECT pg_sleep(0.01)');
      const updated = await primaryPool.query<{ update_time: Date }>(
        `
          UPDATE variant_groups
          SET name = 'after'
          WHERE id = $1
          RETURNING update_time
        `,
        [variantGroupId],
      );
      expect(updated.rows[0].update_time.getTime()).toBeGreaterThan(
        inserted.rows[0].update_time.getTime(),
      );

      const history = await primaryPool.query<{
        id: string;
        hour_ts: string;
        day_ts: string;
        month_ts: string;
      }>(
        `
          INSERT INTO monitor_history (
            country,
            check_time,
            check_result
          )
          VALUES ('US', timestamp '2026-08-28 15:42:37', $1::jsonb)
          RETURNING
            id,
            to_char(hour_ts, 'YYYY-MM-DD HH24:MI:SS') AS hour_ts,
            to_char(day_ts, 'YYYY-MM-DD HH24:MI:SS') AS day_ts,
            to_char(month_ts, 'YYYY-MM-DD HH24:MI:SS') AS month_ts
        `,
        [JSON.stringify({ ok: true })],
      );
      expect(history.rows[0]).toMatchObject({
        hour_ts: '2026-08-28 15:00:00',
        day_ts: '2026-08-28 00:00:00',
        month_ts: '2026-08-01 00:00:00',
      });
      await primaryPool.query('DELETE FROM monitor_history WHERE id = $1', [
        history.rows[0].id,
      ]);

      await expect(
        primaryPool.query(
          `
            INSERT INTO users (id, username, password, status)
            VALUES ($1, $2, 'not-a-real-secret', 'UNKNOWN')
          `,
          [invalidUserId, invalidUserId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    } finally {
      await primaryPool.query('DELETE FROM variant_groups WHERE id = $1', [
        variantGroupId,
      ]);
      await primaryPool.query('DELETE FROM users WHERE id = $1', [
        invalidUserId,
      ]);
    }
  });

  it('幂等 baseline 不重复种子并为两库安装更新时间触发器', async () => {
    const seedCounts = await primaryPool.query<{
      roles: string;
      permissions: string;
      role_permissions: string;
      backup_config: string;
    }>(`
      SELECT
        (SELECT count(*) FROM roles) AS roles,
        (SELECT count(*) FROM permissions) AS permissions,
        (SELECT count(*) FROM role_permissions) AS role_permissions,
        (SELECT count(*) FROM backup_config) AS backup_config
    `);
    expect(seedCounts.rows[0]).toEqual({
      roles: '3',
      permissions: '14',
      role_permissions: '25',
      backup_config: '1',
    });

    const primaryTriggers = await primaryPool.query<{ trigger_name: string }>(`
      SELECT trigger_name
      FROM information_schema.triggers
      WHERE trigger_schema = 'public'
        AND trigger_name LIKE 'trg_%_update%'
      ORDER BY trigger_name
    `);
    expect(
      primaryTriggers.rows.map(({ trigger_name }) => trigger_name),
    ).toEqual([
      'trg_analytics_refresh_watermark_updated_at',
      'trg_asins_update_time',
      'trg_backup_config_update_time',
      'trg_feishu_config_update_time',
      'trg_monitor_history_agg_dim_updated_at',
      'trg_monitor_history_agg_updated_at',
      'trg_monitor_history_agg_variant_group_updated_at',
      'trg_monitor_history_status_interval_updated_at',
      'trg_roles_update_time',
      'trg_sp_api_config_update_time',
      'trg_users_update_time',
      'trg_variant_groups_update_time',
    ]);

    const competitorTriggers = await competitorPool.query<{
      trigger_name: string;
    }>(`
      SELECT trigger_name
      FROM information_schema.triggers
      WHERE trigger_schema = 'public'
        AND trigger_name LIKE 'trg_%_update%'
      ORDER BY trigger_name
    `);
    expect(
      competitorTriggers.rows.map(({ trigger_name }) => trigger_name),
    ).toEqual([
      'trg_competitor_asins_update_time',
      'trg_competitor_feishu_config_update_time',
      'trg_competitor_variant_groups_update_time',
    ]);
  });
});
