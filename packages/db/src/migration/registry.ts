import { getTableColumns, getTableName } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';

import {
  analyticsRefreshWatermark,
  asins,
  auditLogs,
  backupConfig,
  feishuConfig,
  loginAttempts,
  monitorHistory,
  monitorHistoryAgg,
  monitorHistoryAggDim,
  monitorHistoryAggVariantGroup,
  monitorHistoryStatusInterval,
  passwordHistory,
  permissions,
  rolePermissions,
  roles,
  sessions,
  spApiConfig,
  userRoles,
  users,
  userStatusHistory,
  variantGroups,
} from '../schema';
import {
  competitorAsins,
  competitorFeishuConfig,
  competitorMonitorHistory,
  competitorVariantGroups,
} from '../schema-competitor';

export type MigrationDatabaseName = 'primary' | 'competitor';

export interface TableMigrationSpec {
  readonly table: PgTable;
  readonly name: string;
  readonly columns: readonly string[];
  readonly insertColumns: readonly string[];
  readonly primaryKeyColumns: readonly string[];
  readonly booleanColumns: ReadonlySet<string>;
  readonly jsonColumns: ReadonlySet<string>;
  readonly generatedColumns: ReadonlySet<string>;
  readonly identityColumns: readonly string[];
}

export interface BusinessQuerySpec {
  readonly name: string;
  readonly sourceSql: string;
  readonly targetSql: string;
}

export interface DatabaseMigrationSpec {
  readonly logicalName: MigrationDatabaseName;
  readonly tables: readonly TableMigrationSpec[];
  readonly businessQueries: readonly BusinessQuerySpec[];
}

function tableSpec(table: PgTable): TableMigrationSpec {
  const tableName = getTableName(table);
  const columns = Object.values(getTableColumns(table));
  const tableConfig = getTableConfig(table);
  const inlinePrimaryKeys = columns
    .filter((column) => column.primary)
    .map((column) => column.name);
  const compositePrimaryKeys = tableConfig.primaryKeys.flatMap((primaryKey) =>
    primaryKey.columns.map((column) => column.name),
  );
  const primaryKeyColumns =
    compositePrimaryKeys.length > 0 ? compositePrimaryKeys : inlinePrimaryKeys;

  if (primaryKeyColumns.length === 0) {
    throw new Error(`migration table ${tableName} has no primary key`);
  }

  const generatedColumns = new Set(
    columns
      .filter((column) => Boolean(column.generated))
      .map((column) => column.name),
  );

  return Object.freeze({
    table,
    name: tableName,
    columns: Object.freeze(columns.map((column) => column.name)),
    insertColumns: Object.freeze(
      columns
        .map((column) => column.name)
        .filter((column) => !generatedColumns.has(column)),
    ),
    primaryKeyColumns: Object.freeze(primaryKeyColumns),
    booleanColumns: new Set(
      columns
        .filter((column) => column.getSQLType() === 'boolean')
        .map((column) => column.name),
    ),
    jsonColumns: new Set(
      columns
        .filter((column) => column.getSQLType() === 'jsonb')
        .map((column) => column.name),
    ),
    generatedColumns,
    identityColumns: Object.freeze(
      columns
        .filter((column) => Boolean(column.generatedIdentity))
        .map((column) => column.name),
    ),
  });
}

// Parent tables precede children so FK checks remain enabled during import.
const primaryTables = [
  variantGroups,
  users,
  roles,
  permissions,
  feishuConfig,
  spApiConfig,
  backupConfig,
  asins,
  monitorHistory,
  monitorHistoryAgg,
  monitorHistoryAggDim,
  monitorHistoryAggVariantGroup,
  analyticsRefreshWatermark,
  monitorHistoryStatusInterval,
  passwordHistory,
  loginAttempts,
  userStatusHistory,
  sessions,
  userRoles,
  rolePermissions,
  auditLogs,
].map(tableSpec);

const competitorTables = [
  competitorVariantGroups,
  competitorAsins,
  competitorMonitorHistory,
  competitorFeishuConfig,
].map(tableSpec);

const primaryBusinessQueries: readonly BusinessQuerySpec[] = [
  {
    name: 'asin_health_by_country',
    sourceSql: `
      SELECT
        country,
        CAST(COUNT(*) AS CHAR) AS total_count,
        CAST(COALESCE(SUM(CASE WHEN is_broken = 1 THEN 1 ELSE 0 END), 0) AS CHAR) AS broken_count,
        CAST(COALESCE(SUM(CASE WHEN manual_excluded_from_group = 1 THEN 1 ELSE 0 END), 0) AS CHAR) AS excluded_count
      FROM asins
      GROUP BY country
      ORDER BY country
    `,
    targetSql: `
      SELECT
        country,
        COUNT(*)::text AS total_count,
        COALESCE(SUM(CASE WHEN is_broken THEN 1 ELSE 0 END), 0)::text AS broken_count,
        COALESCE(SUM(CASE WHEN manual_excluded_from_group THEN 1 ELSE 0 END), 0)::text AS excluded_count
      FROM asins
      GROUP BY country
      ORDER BY country
    `,
  },
  {
    name: 'variant_health_by_country',
    sourceSql: `
      SELECT
        country,
        CAST(COUNT(*) AS CHAR) AS total_count,
        CAST(COALESCE(SUM(CASE WHEN is_broken = 1 THEN 1 ELSE 0 END), 0) AS CHAR) AS broken_count,
        CAST(COALESCE(SUM(CASE WHEN manual_broken = 1 THEN 1 ELSE 0 END), 0) AS CHAR) AS manual_count
      FROM variant_groups
      GROUP BY country
      ORDER BY country
    `,
    targetSql: `
      SELECT
        country,
        COUNT(*)::text AS total_count,
        COALESCE(SUM(CASE WHEN is_broken THEN 1 ELSE 0 END), 0)::text AS broken_count,
        COALESCE(SUM(CASE WHEN manual_broken THEN 1 ELSE 0 END), 0)::text AS manual_count
      FROM variant_groups
      GROUP BY country
      ORDER BY country
    `,
  },
  {
    name: 'history_by_country_and_type',
    sourceSql: `
      SELECT
        country,
        COALESCE(check_type, '') AS check_type,
        CAST(COUNT(*) AS CHAR) AS total_count,
        CAST(COALESCE(SUM(CASE WHEN is_broken = 1 THEN 1 ELSE 0 END), 0) AS CHAR) AS broken_count,
        CAST(COALESCE(SUM(CASE WHEN notification_sent = 1 THEN 1 ELSE 0 END), 0) AS CHAR) AS notified_count
      FROM monitor_history
      GROUP BY country, COALESCE(check_type, '')
      ORDER BY country, COALESCE(check_type, '')
    `,
    targetSql: `
      SELECT
        country,
        COALESCE(check_type, '') AS check_type,
        COUNT(*)::text AS total_count,
        COALESCE(SUM(CASE WHEN is_broken THEN 1 ELSE 0 END), 0)::text AS broken_count,
        COALESCE(SUM(CASE WHEN notification_sent THEN 1 ELSE 0 END), 0)::text AS notified_count
      FROM monitor_history
      GROUP BY country, COALESCE(check_type, '')
      ORDER BY country, COALESCE(check_type, '')
    `,
  },
  {
    name: 'rbac_permissions_by_role',
    sourceSql: `
      SELECT
        roles.code,
        CAST(COUNT(role_permissions.permission_id) AS CHAR) AS permission_count
      FROM roles
      LEFT JOIN role_permissions ON role_permissions.role_id = roles.id
      GROUP BY roles.code
      ORDER BY roles.code
    `,
    targetSql: `
      SELECT
        roles.code,
        COUNT(role_permissions.permission_id)::text AS permission_count
      FROM roles
      LEFT JOIN role_permissions ON role_permissions.role_id = roles.id
      GROUP BY roles.code
      ORDER BY roles.code
    `,
  },
  {
    name: 'analytics_rows_by_granularity',
    sourceSql: `
      SELECT 'asin' AS aggregate_name, granularity, country, CAST(COUNT(*) AS CHAR) AS row_count
      FROM monitor_history_agg
      GROUP BY granularity, country
      UNION ALL
      SELECT 'dimension' AS aggregate_name, granularity, country, CAST(COUNT(*) AS CHAR) AS row_count
      FROM monitor_history_agg_dim
      GROUP BY granularity, country
      UNION ALL
      SELECT 'variant_group' AS aggregate_name, granularity, country, CAST(COUNT(*) AS CHAR) AS row_count
      FROM monitor_history_agg_variant_group
      GROUP BY granularity, country
      ORDER BY aggregate_name, granularity, country
    `,
    targetSql: `
      SELECT 'asin' AS aggregate_name, granularity, country, COUNT(*)::text AS row_count
      FROM monitor_history_agg
      GROUP BY granularity, country
      UNION ALL
      SELECT 'dimension' AS aggregate_name, granularity, country, COUNT(*)::text AS row_count
      FROM monitor_history_agg_dim
      GROUP BY granularity, country
      UNION ALL
      SELECT 'variant_group' AS aggregate_name, granularity, country, COUNT(*)::text AS row_count
      FROM monitor_history_agg_variant_group
      GROUP BY granularity, country
      ORDER BY aggregate_name, granularity, country
    `,
  },
];

const competitorBusinessQueries: readonly BusinessQuerySpec[] = [
  {
    name: 'competitor_asin_health_by_country',
    sourceSql: `
      SELECT
        country,
        CAST(COUNT(*) AS CHAR) AS total_count,
        CAST(COALESCE(SUM(CASE WHEN is_broken = 1 THEN 1 ELSE 0 END), 0) AS CHAR) AS broken_count
      FROM competitor_asins
      GROUP BY country
      ORDER BY country
    `,
    targetSql: `
      SELECT
        country,
        COUNT(*)::text AS total_count,
        COALESCE(SUM(CASE WHEN is_broken THEN 1 ELSE 0 END), 0)::text AS broken_count
      FROM competitor_asins
      GROUP BY country
      ORDER BY country
    `,
  },
  {
    name: 'competitor_history_by_country_and_type',
    sourceSql: `
      SELECT
        country,
        COALESCE(check_type, '') AS check_type,
        CAST(COUNT(*) AS CHAR) AS total_count,
        CAST(COALESCE(SUM(CASE WHEN is_broken = 1 THEN 1 ELSE 0 END), 0) AS CHAR) AS broken_count
      FROM competitor_monitor_history
      GROUP BY country, COALESCE(check_type, '')
      ORDER BY country, COALESCE(check_type, '')
    `,
    targetSql: `
      SELECT
        country,
        COALESCE(check_type, '') AS check_type,
        COUNT(*)::text AS total_count,
        COALESCE(SUM(CASE WHEN is_broken THEN 1 ELSE 0 END), 0)::text AS broken_count
      FROM competitor_monitor_history
      GROUP BY country, COALESCE(check_type, '')
      ORDER BY country, COALESCE(check_type, '')
    `,
  },
];

export const databaseMigrationSpecs: readonly DatabaseMigrationSpec[] = [
  Object.freeze({
    logicalName: 'primary',
    tables: Object.freeze(primaryTables),
    businessQueries: Object.freeze(primaryBusinessQueries),
  }),
  Object.freeze({
    logicalName: 'competitor',
    tables: Object.freeze(competitorTables),
    businessQueries: Object.freeze(competitorBusinessQueries),
  }),
];
