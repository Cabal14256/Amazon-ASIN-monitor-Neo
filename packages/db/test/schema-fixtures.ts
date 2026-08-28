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
} from '../src/schema';
import {
  competitorAsins,
  competitorFeishuConfig,
  competitorMonitorHistory,
  competitorVariantGroups,
} from '../src/schema-competitor';

export const primaryTableNames = [
  'analytics_refresh_watermark',
  'asins',
  'audit_logs',
  'backup_config',
  'feishu_config',
  'login_attempts',
  'monitor_history',
  'monitor_history_agg',
  'monitor_history_agg_dim',
  'monitor_history_agg_variant_group',
  'monitor_history_status_interval',
  'password_history',
  'permissions',
  'role_permissions',
  'roles',
  'sessions',
  'sp_api_config',
  'user_roles',
  'user_status_history',
  'users',
  'variant_groups',
] as const;

export const competitorTableNames = [
  'competitor_asins',
  'competitor_feishu_config',
  'competitor_monitor_history',
  'competitor_variant_groups',
] as const;

export const primaryDrizzleTables = [
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
  userStatusHistory,
  users,
  variantGroups,
] as const;

export const competitorDrizzleTables = [
  competitorAsins,
  competitorFeishuConfig,
  competitorMonitorHistory,
  competitorVariantGroups,
] as const;

export function drizzleTableNames(tables: readonly PgTable[]): string[] {
  return tables.map((table) => getTableName(table)).sort();
}

export function drizzleColumnKeys(tables: readonly PgTable[]): string[] {
  return tables
    .flatMap((table) =>
      Object.values(getTableColumns(table)).map(
        (column) => `${getTableName(table)}.${column.name}`,
      ),
    )
    .sort();
}

export function drizzleIndexNames(tables: readonly PgTable[]): string[] {
  return tables
    .flatMap((table) =>
      getTableConfig(table).indexes.map((index) => index.config.name),
    )
    .filter((name): name is string => Boolean(name))
    .sort();
}
