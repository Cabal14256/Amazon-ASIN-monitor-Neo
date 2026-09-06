import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  char,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { shanghaiTimestamp as timestampColumn } from '../timestamps';

const localTimestamp = sql`LOCALTIMESTAMP`;

export const variantGroups = pgTable(
  'variant_groups',
  {
    id: varchar('id', { length: 50 }).primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    country: varchar('country', { length: 10 }).notNull(),
    site: varchar('site', { length: 100 }).notNull(),
    brand: varchar('brand', { length: 100 }).notNull(),
    isBroken: boolean('is_broken').default(false),
    variantStatus: varchar('variant_status', { length: 20 }).default('NORMAL'),
    manualBroken: boolean('manual_broken').default(false),
    manualBrokenReason: varchar('manual_broken_reason', { length: 500 }),
    manualBrokenUpdatedAt: timestampColumn('manual_broken_updated_at'),
    manualBrokenUpdatedBy: varchar('manual_broken_updated_by', { length: 100 }),
    isCompetitor: boolean('is_competitor').default(false),
    createTime: timestampColumn('create_time').default(localTimestamp),
    updateTime: timestampColumn('update_time').default(localTimestamp),
    lastCheckTime: timestampColumn('last_check_time'),
    feishuNotifyEnabled: boolean('feishu_notify_enabled').default(true),
  },
  (table) => [
    index('idx_variant_groups_country').on(table.country),
    index('idx_variant_groups_site').on(table.site),
    index('idx_variant_groups_brand').on(table.brand),
    index('idx_variant_groups_is_broken').on(table.isBroken),
    index('idx_variant_groups_manual_broken').on(table.manualBroken),
    index('idx_variant_groups_create_time').on(table.createTime),
    index('idx_variant_groups_last_check_time').on(table.lastCheckTime),
    index('idx_variant_groups_feishu_notify_enabled').on(
      table.feishuNotifyEnabled,
    ),
    index('idx_variant_groups_country_broken').on(
      table.country,
      table.isBroken,
    ),
    index('idx_variant_groups_name').on(table.name),
  ],
);

export const asins = pgTable(
  'asins',
  {
    id: varchar('id', { length: 50 }).primaryKey(),
    asin: varchar('asin', { length: 20 }).notNull(),
    name: varchar('name', { length: 500 }),
    asinType: varchar('asin_type', { length: 20 }),
    country: varchar('country', { length: 10 }).notNull(),
    site: varchar('site', { length: 100 }).notNull(),
    brand: varchar('brand', { length: 100 }).notNull(),
    variantGroupId: varchar('variant_group_id', { length: 50 }).notNull(),
    isBroken: boolean('is_broken').default(false),
    variantStatus: varchar('variant_status', { length: 20 }).default('NORMAL'),
    manualBroken: boolean('manual_broken').default(false),
    manualBrokenReason: varchar('manual_broken_reason', { length: 500 }),
    manualBrokenUpdatedAt: timestampColumn('manual_broken_updated_at'),
    manualBrokenUpdatedBy: varchar('manual_broken_updated_by', { length: 100 }),
    manualExcludedFromGroup: boolean('manual_excluded_from_group').default(
      false,
    ),
    manualExcludedReason: varchar('manual_excluded_reason', { length: 500 }),
    manualExcludedUpdatedAt: timestampColumn('manual_excluded_updated_at'),
    manualExcludedUpdatedBy: varchar('manual_excluded_updated_by', {
      length: 100,
    }),
    createTime: timestampColumn('create_time').default(localTimestamp),
    updateTime: timestampColumn('update_time').default(localTimestamp),
    lastCheckTime: timestampColumn('last_check_time'),
    feishuNotifyEnabled: boolean('feishu_notify_enabled').default(true),
  },
  (table) => [
    unique('uk_asins_asin_country').on(table.asin, table.country),
    foreignKey({
      name: 'fk_asins_variant_group',
      columns: [table.variantGroupId],
      foreignColumns: [variantGroups.id],
    }).onDelete('cascade'),
    index('idx_asins_variant_group_id').on(table.variantGroupId),
    index('idx_asins_country').on(table.country),
    index('idx_asins_site').on(table.site),
    index('idx_asins_brand').on(table.brand),
    index('idx_asins_asin').on(table.asin),
    index('idx_asins_asin_type').on(table.asinType),
    index('idx_asins_is_broken').on(table.isBroken),
    index('idx_asins_manual_broken').on(table.manualBroken),
    index('idx_asins_manual_excluded_from_group').on(
      table.manualExcludedFromGroup,
    ),
    index('idx_asins_last_check_time').on(table.lastCheckTime),
    index('idx_asins_feishu_notify_enabled').on(table.feishuNotifyEnabled),
    index('idx_asins_variant_group_country_broken').on(
      table.variantGroupId,
      table.country,
      table.isBroken,
    ),
    uniqueIndex('uq_asins_asin_country_ci').on(
      sql`lower(${table.asin})`,
      sql`lower(${table.country})`,
    ),
  ],
);

export const monitorHistory = pgTable(
  'monitor_history',
  {
    id: bigint('id', { mode: 'bigint' }).generatedAlwaysAsIdentity(),
    variantGroupId: varchar('variant_group_id', { length: 50 }),
    variantGroupName: varchar('variant_group_name', { length: 255 }),
    asinId: varchar('asin_id', { length: 50 }),
    asinCode: varchar('asin_code', { length: 20 }),
    asinName: varchar('asin_name', { length: 500 }),
    siteSnapshot: varchar('site_snapshot', { length: 100 }),
    brandSnapshot: varchar('brand_snapshot', { length: 255 }),
    checkType: varchar('check_type', { length: 20 }).default('GROUP'),
    country: varchar('country', { length: 10 }).notNull(),
    isBroken: boolean('is_broken').default(false),
    checkTime: timestampColumn('check_time').notNull(),
    hourTs: timestampColumn('hour_ts').generatedAlwaysAs(
      sql`date_trunc('hour', "check_time")`,
    ),
    dayTs: timestampColumn('day_ts').generatedAlwaysAs(
      sql`date_trunc('day', "check_time")`,
    ),
    monthTs: timestampColumn('month_ts').generatedAlwaysAs(
      sql`date_trunc('month', "check_time")`,
    ),
    checkResult: jsonb('check_result').$type<Record<string, unknown>>(),
    notificationSent: boolean('notification_sent').default(false),
    createTime: timestampColumn('create_time').default(localTimestamp),
  },
  (table) => [
    primaryKey({
      name: 'monitor_history_pkey',
      columns: [table.checkTime, table.id],
    }),
    index('idx_monitor_history_id_lookup').on(table.id),
    index('idx_monitor_history_variant_group_time').on(
      table.variantGroupId,
      table.checkTime.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    index('idx_monitor_history_country_time').on(
      table.country,
      table.checkTime.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    index('idx_monitor_history_asin_code_country_time').on(
      table.asinCode,
      table.country,
      table.checkTime.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    index('idx_monitor_history_asin_country_time').on(
      table.asinId,
      table.country,
      table.checkTime.desc().nullsFirst(),
      table.id.desc().nullsFirst(),
    ),
    index('idx_monitor_history_status_interval_refresh').on(
      table.checkType,
      table.checkTime,
      table.id,
    ),
    index('idx_monitor_history_notification_pending')
      .on(table.country, table.checkTime, table.id)
      .where(
        sql`${table.isBroken} = true AND ${table.notificationSent} = false`,
      ),
  ],
);

export const monitorHistoryAgg = pgTable(
  'monitor_history_agg',
  {
    granularity: varchar('granularity', { length: 5 }).notNull(),
    timeSlot: timestampColumn('time_slot').notNull(),
    country: varchar('country', { length: 10 }).notNull(),
    asinKey: varchar('asin_key', { length: 50 }).notNull(),
    checkCount: integer('check_count').notNull(),
    brokenCount: integer('broken_count').notNull(),
    hasBroken: boolean('has_broken').notNull(),
    hasPeak: boolean('has_peak').notNull(),
    firstCheckTime: timestampColumn('first_check_time').notNull(),
    lastCheckTime: timestampColumn('last_check_time').notNull(),
    updatedAt: timestampColumn('updated_at').default(localTimestamp),
  },
  (table) => [
    check(
      'ck_monitor_history_agg_granularity',
      sql`${table.granularity} IN ('hour', 'day', 'month')`,
    ),
    primaryKey({
      name: 'pk_monitor_history_agg',
      columns: [
        table.granularity,
        table.timeSlot,
        table.country,
        table.asinKey,
      ],
    }),
    index('idx_monitor_history_agg_time_slot').on(table.timeSlot),
    index('idx_monitor_history_agg_country_time_slot').on(
      table.country,
      table.timeSlot,
    ),
    index('idx_monitor_history_agg_granularity_time_slot').on(
      table.granularity,
      table.timeSlot,
    ),
  ],
);

export const monitorHistoryAggDim = pgTable(
  'monitor_history_agg_dim',
  {
    granularity: varchar('granularity', { length: 5 }).notNull(),
    timeSlot: timestampColumn('time_slot').notNull(),
    country: varchar('country', { length: 10 }).notNull(),
    site: varchar('site', { length: 100 }).notNull().default(''),
    brand: varchar('brand', { length: 255 }).notNull().default(''),
    asinKey: varchar('asin_key', { length: 50 }).notNull(),
    checkCount: integer('check_count').notNull(),
    brokenCount: integer('broken_count').notNull(),
    hasBroken: boolean('has_broken').notNull(),
    hasPeak: boolean('has_peak').notNull(),
    firstCheckTime: timestampColumn('first_check_time').notNull(),
    lastCheckTime: timestampColumn('last_check_time').notNull(),
    updatedAt: timestampColumn('updated_at').default(localTimestamp),
  },
  (table) => [
    check(
      'ck_monitor_history_agg_dim_granularity',
      sql`${table.granularity} IN ('hour', 'day', 'month')`,
    ),
    primaryKey({
      name: 'pk_monitor_history_agg_dim',
      columns: [
        table.granularity,
        table.timeSlot,
        table.country,
        table.site,
        table.brand,
        table.asinKey,
      ],
    }),
    index('idx_monitor_history_agg_dim_time_slot').on(table.timeSlot),
    index('idx_monitor_history_agg_dim_country_time_slot').on(
      table.country,
      table.timeSlot,
    ),
    index('idx_monitor_history_agg_dim_granularity_time_slot').on(
      table.granularity,
      table.timeSlot,
    ),
    index('idx_monitor_history_agg_dim_country_site_brand_slot').on(
      table.country,
      table.site,
      table.brand,
      table.timeSlot,
    ),
  ],
);

export const monitorHistoryAggVariantGroup = pgTable(
  'monitor_history_agg_variant_group',
  {
    granularity: varchar('granularity', { length: 5 }).notNull(),
    timeSlot: timestampColumn('time_slot').notNull(),
    country: varchar('country', { length: 10 }).notNull(),
    variantGroupId: varchar('variant_group_id', { length: 50 }).notNull(),
    variantGroupName: varchar('variant_group_name', { length: 255 })
      .notNull()
      .default(''),
    asinKey: varchar('asin_key', { length: 50 }).notNull(),
    checkCount: integer('check_count').notNull(),
    brokenCount: integer('broken_count').notNull(),
    hasBroken: boolean('has_broken').notNull(),
    hasPeak: boolean('has_peak').notNull(),
    firstCheckTime: timestampColumn('first_check_time').notNull(),
    lastCheckTime: timestampColumn('last_check_time').notNull(),
    updatedAt: timestampColumn('updated_at').default(localTimestamp),
  },
  (table) => [
    check(
      'ck_monitor_history_agg_variant_group_granularity',
      sql`${table.granularity} IN ('hour', 'day', 'month')`,
    ),
    primaryKey({
      name: 'pk_monitor_history_agg_variant_group',
      columns: [
        table.granularity,
        table.timeSlot,
        table.country,
        table.variantGroupId,
        table.asinKey,
      ],
    }),
    index('idx_monitor_history_agg_variant_group_slot').on(table.timeSlot),
    index('idx_monitor_history_agg_variant_group_country_slot').on(
      table.country,
      table.timeSlot,
    ),
    index('idx_monitor_history_agg_variant_group_lookup').on(
      table.granularity,
      table.country,
      table.variantGroupId,
      table.timeSlot,
    ),
    index('idx_monitor_history_agg_variant_group_time_slot').on(table.timeSlot),
    index('idx_monitor_history_agg_variant_group_country_time_slot').on(
      table.country,
      table.timeSlot,
    ),
    index('idx_monitor_history_agg_variant_group_group_slot').on(
      table.variantGroupId,
      table.timeSlot,
    ),
    index('idx_monitor_history_agg_variant_group_granularity_time_slot').on(
      table.granularity,
      table.timeSlot,
    ),
  ],
);

export const analyticsRefreshWatermark = pgTable(
  'analytics_refresh_watermark',
  {
    processorName: varchar('processor_name', { length: 100 }).primaryKey(),
    lastHistoryId: bigint('last_history_id', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    lastCheckTime: timestampColumn('last_check_time'),
    updatedAt: timestampColumn('updated_at').default(localTimestamp),
  },
);

export const monitorHistoryStatusInterval = pgTable(
  'monitor_history_status_interval',
  {
    asinKey: varchar('asin_key', { length: 50 }).notNull(),
    asinId: varchar('asin_id', { length: 50 }),
    asinCode: varchar('asin_code', { length: 20 }),
    asinName: varchar('asin_name', { length: 500 }),
    country: varchar('country', { length: 10 }).notNull(),
    variantGroupId: varchar('variant_group_id', { length: 50 }),
    variantGroupName: varchar('variant_group_name', { length: 255 }),
    intervalStart: timestampColumn('interval_start').notNull(),
    intervalEnd: timestampColumn('interval_end'),
    isBroken: boolean('is_broken').notNull(),
    updatedAt: timestampColumn('updated_at').default(localTimestamp),
  },
  (table) => [
    primaryKey({
      name: 'pk_monitor_history_status_interval',
      columns: [table.asinKey, table.country, table.intervalStart],
    }),
    index('idx_monitor_history_status_interval_country_start').on(
      table.country,
      table.intervalStart,
    ),
    index('idx_monitor_history_status_interval_variant_group_start').on(
      table.variantGroupId,
      table.country,
      table.intervalStart,
    ),
    index('idx_monitor_history_status_interval_range').on(
      table.intervalStart,
      table.intervalEnd,
    ),
    index('idx_monitor_history_status_interval_broken_range').on(
      table.isBroken,
      table.intervalStart,
      table.intervalEnd,
    ),
    index('idx_monitor_history_status_interval_open_lookup').on(
      table.asinKey,
      table.country,
      table.intervalEnd,
    ),
  ],
);

export const feishuConfig = pgTable(
  'feishu_config',
  {
    id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
    country: varchar('country', { length: 10 }).notNull().unique(),
    webhookUrl: varchar('webhook_url', { length: 500 }).notNull(),
    enabled: boolean('enabled').default(true),
    createTime: timestampColumn('create_time').default(localTimestamp),
    updateTime: timestampColumn('update_time').default(localTimestamp),
  },
  (table) => [
    uniqueIndex('uq_feishu_config_country_ci').on(sql`lower(${table.country})`),
  ],
);

export const spApiConfig = pgTable(
  'sp_api_config',
  {
    id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
    configKey: varchar('config_key', { length: 50 }).notNull().unique(),
    configValue: text('config_value'),
    description: varchar('description', { length: 255 }),
    createTime: timestampColumn('create_time').default(localTimestamp),
    updateTime: timestampColumn('update_time').default(localTimestamp),
  },
  (table) => [
    index('idx_sp_api_config_key').on(table.configKey),
    uniqueIndex('uq_sp_api_config_key_ci').on(sql`lower(${table.configKey})`),
  ],
);

export const backupConfig = pgTable('backup_config', {
  id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
  enabled: boolean('enabled').default(false),
  scheduleType: varchar('schedule_type', { length: 20 }).default('daily'),
  scheduleValue: integer('schedule_value'),
  backupTime: varchar('backup_time', { length: 10 }).default('02:00'),
  createTime: timestampColumn('create_time').default(localTimestamp),
  updateTime: timestampColumn('update_time').default(localTimestamp),
});

export const users = pgTable(
  'users',
  {
    id: varchar('id', { length: 50 }).primaryKey(),
    username: varchar('username', { length: 50 }).notNull().unique(),
    password: varchar('password', { length: 255 }).notNull(),
    realName: varchar('real_name', { length: 100 }),
    status: varchar('status', { length: 10 }).notNull().default('ACTIVE'),
    lastLoginTime: timestampColumn('last_login_time'),
    lastLoginIp: varchar('last_login_ip', { length: 50 }),
    passwordExpiresAt: timestampColumn('password_expires_at'),
    passwordChangedAt: timestampColumn('password_changed_at'),
    forcePasswordChange: boolean('force_password_change').default(false),
    failedLoginAttempts: integer('failed_login_attempts').default(0),
    lockedUntil: timestampColumn('locked_until'),
    lastFailedLogin: timestampColumn('last_failed_login'),
    createTime: timestampColumn('create_time').default(localTimestamp),
    updateTime: timestampColumn('update_time').default(localTimestamp),
  },
  (table) => [
    check(
      'ck_users_status',
      sql`${table.status} IN ('ACTIVE', 'INACTIVE', 'LOCKED', 'SUSPENDED', 'PENDING')`,
    ),
    index('idx_users_username').on(table.username),
    index('idx_users_status').on(table.status),
    uniqueIndex('uq_users_username_ci').on(sql`lower(${table.username})`),
  ],
);

export const passwordHistory = pgTable(
  'password_history',
  {
    id: bigint('id', { mode: 'bigint' })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    userId: varchar('user_id', { length: 50 }).notNull(),
    passwordHash: varchar('password_hash', { length: 255 }).notNull(),
    createdAt: timestampColumn('created_at').default(localTimestamp),
  },
  (table) => [
    foreignKey({
      name: 'fk_password_history_user',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    index('idx_password_history_user_id').on(table.userId),
    index('idx_password_history_user_created').on(
      table.userId,
      table.createdAt,
    ),
  ],
);

export const loginAttempts = pgTable(
  'login_attempts',
  {
    id: bigint('id', { mode: 'bigint' })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    username: varchar('username', { length: 50 }).notNull(),
    ipAddress: varchar('ip_address', { length: 64 }),
    success: boolean('success').notNull(),
    createdAt: timestampColumn('created_at').default(localTimestamp),
  },
  (table) => [
    index('idx_login_attempts_username_time').on(
      table.username,
      table.createdAt,
    ),
    index('idx_login_attempts_ip_time').on(table.ipAddress, table.createdAt),
    index('idx_login_attempts_created_at').on(table.createdAt),
  ],
);

export const userStatusHistory = pgTable(
  'user_status_history',
  {
    id: bigint('id', { mode: 'bigint' })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    userId: varchar('user_id', { length: 50 }).notNull(),
    oldStatus: varchar('old_status', { length: 20 }),
    newStatus: varchar('new_status', { length: 20 }).notNull(),
    reason: varchar('reason', { length: 255 }),
    changedBy: varchar('changed_by', { length: 50 }),
    createdAt: timestampColumn('created_at').default(localTimestamp),
  },
  (table) => [
    foreignKey({
      name: 'fk_user_status_history_user',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    index('idx_user_status_history_user_id').on(table.userId),
    index('idx_user_status_history_created_at').on(table.createdAt),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: char('id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 50 }).notNull(),
    userAgent: varchar('user_agent', { length: 255 }),
    ipAddress: varchar('ip_address', { length: 64 }),
    status: varchar('status', { length: 7 }).notNull().default('ACTIVE'),
    rememberMe: boolean('remember_me').notNull().default(false),
    createdAt: timestampColumn('created_at').notNull().default(localTimestamp),
    lastActiveAt: timestampColumn('last_active_at')
      .notNull()
      .default(localTimestamp),
    expiresAt: timestampColumn('expires_at'),
  },
  (table) => [
    check('ck_sessions_status', sql`${table.status} IN ('ACTIVE', 'REVOKED')`),
    foreignKey({
      name: 'fk_sessions_user_id',
      columns: [table.userId],
      foreignColumns: [users.id],
    })
      .onDelete('cascade')
      .onUpdate('cascade'),
    index('idx_sessions_user_id').on(table.userId),
  ],
);

export const roles = pgTable(
  'roles',
  {
    id: varchar('id', { length: 50 }).primaryKey(),
    code: varchar('code', { length: 50 }).notNull().unique(),
    name: varchar('name', { length: 100 }).notNull(),
    description: varchar('description', { length: 255 }),
    createTime: timestampColumn('create_time').default(localTimestamp),
    updateTime: timestampColumn('update_time').default(localTimestamp),
  },
  (table) => [
    index('idx_roles_code').on(table.code),
    uniqueIndex('uq_roles_code_ci').on(sql`lower(${table.code})`),
  ],
);

export const permissions = pgTable(
  'permissions',
  {
    id: varchar('id', { length: 50 }).primaryKey(),
    code: varchar('code', { length: 50 }).notNull().unique(),
    name: varchar('name', { length: 100 }).notNull(),
    resource: varchar('resource', { length: 100 }),
    action: varchar('action', { length: 50 }),
    description: varchar('description', { length: 255 }),
    createTime: timestampColumn('create_time').default(localTimestamp),
  },
  (table) => [
    index('idx_permissions_code').on(table.code),
    index('idx_permissions_resource').on(table.resource),
    uniqueIndex('uq_permissions_code_ci').on(sql`lower(${table.code})`),
  ],
);

export const userRoles = pgTable(
  'user_roles',
  {
    id: bigint('id', { mode: 'bigint' })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    userId: varchar('user_id', { length: 50 }).notNull(),
    roleId: varchar('role_id', { length: 50 }).notNull(),
    createTime: timestampColumn('create_time').default(localTimestamp),
  },
  (table) => [
    unique('uk_user_roles_user_role').on(table.userId, table.roleId),
    foreignKey({
      name: 'fk_user_roles_user',
      columns: [table.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_user_roles_role',
      columns: [table.roleId],
      foreignColumns: [roles.id],
    }).onDelete('cascade'),
    index('idx_user_roles_user_id').on(table.userId),
    index('idx_user_roles_role_id').on(table.roleId),
  ],
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    id: bigint('id', { mode: 'bigint' })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    roleId: varchar('role_id', { length: 50 }).notNull(),
    permissionId: varchar('permission_id', { length: 50 }).notNull(),
    createTime: timestampColumn('create_time').default(localTimestamp),
  },
  (table) => [
    unique('uk_role_permissions_role_permission').on(
      table.roleId,
      table.permissionId,
    ),
    foreignKey({
      name: 'fk_role_permissions_role',
      columns: [table.roleId],
      foreignColumns: [roles.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'fk_role_permissions_permission',
      columns: [table.permissionId],
      foreignColumns: [permissions.id],
    }).onDelete('cascade'),
    index('idx_role_permissions_role_id').on(table.roleId),
    index('idx_role_permissions_permission_id').on(table.permissionId),
  ],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: bigint('id', { mode: 'bigint' })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    userId: varchar('user_id', { length: 50 }),
    username: varchar('username', { length: 50 }),
    action: varchar('action', { length: 50 }).notNull(),
    resource: varchar('resource', { length: 100 }),
    resourceId: varchar('resource_id', { length: 50 }),
    resourceName: varchar('resource_name', { length: 255 }),
    method: varchar('method', { length: 10 }),
    path: varchar('path', { length: 500 }),
    ipAddress: varchar('ip_address', { length: 50 }),
    userAgent: varchar('user_agent', { length: 500 }),
    requestData: jsonb('request_data').$type<Record<string, unknown>>(),
    responseStatus: integer('response_status'),
    errorMessage: text('error_message'),
    createTime: timestampColumn('create_time').default(localTimestamp),
  },
  (table) => [
    index('idx_audit_logs_user_id').on(table.userId),
    index('idx_audit_logs_username').on(table.username),
    index('idx_audit_logs_action').on(table.action),
    index('idx_audit_logs_resource').on(table.resource),
    index('idx_audit_logs_create_time').on(table.createTime),
    index('idx_audit_logs_resource_id').on(table.resourceId),
  ],
);

export type VariantGroup = typeof variantGroups.$inferSelect;
export type NewVariantGroup = typeof variantGroups.$inferInsert;
export type Asin = typeof asins.$inferSelect;
export type NewAsin = typeof asins.$inferInsert;
export type MonitorHistory = typeof monitorHistory.$inferSelect;
export type NewMonitorHistory = typeof monitorHistory.$inferInsert;
export type MonitorHistoryAgg = typeof monitorHistoryAgg.$inferSelect;
export type NewMonitorHistoryAgg = typeof monitorHistoryAgg.$inferInsert;
export type MonitorHistoryAggDim = typeof monitorHistoryAggDim.$inferSelect;
export type NewMonitorHistoryAggDim = typeof monitorHistoryAggDim.$inferInsert;
export type MonitorHistoryAggVariantGroup =
  typeof monitorHistoryAggVariantGroup.$inferSelect;
export type NewMonitorHistoryAggVariantGroup =
  typeof monitorHistoryAggVariantGroup.$inferInsert;
export type AnalyticsRefreshWatermark =
  typeof analyticsRefreshWatermark.$inferSelect;
export type NewAnalyticsRefreshWatermark =
  typeof analyticsRefreshWatermark.$inferInsert;
export type MonitorHistoryStatusInterval =
  typeof monitorHistoryStatusInterval.$inferSelect;
export type NewMonitorHistoryStatusInterval =
  typeof monitorHistoryStatusInterval.$inferInsert;
export type FeishuConfig = typeof feishuConfig.$inferSelect;
export type NewFeishuConfig = typeof feishuConfig.$inferInsert;
export type SpApiConfig = typeof spApiConfig.$inferSelect;
export type NewSpApiConfig = typeof spApiConfig.$inferInsert;
export type BackupConfig = typeof backupConfig.$inferSelect;
export type NewBackupConfig = typeof backupConfig.$inferInsert;
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type PasswordHistory = typeof passwordHistory.$inferSelect;
export type NewPasswordHistory = typeof passwordHistory.$inferInsert;
export type LoginAttempt = typeof loginAttempts.$inferSelect;
export type NewLoginAttempt = typeof loginAttempts.$inferInsert;
export type UserStatusHistory = typeof userStatusHistory.$inferSelect;
export type NewUserStatusHistory = typeof userStatusHistory.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;
export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type Permission = typeof permissions.$inferSelect;
export type NewPermission = typeof permissions.$inferInsert;
export type UserRole = typeof userRoles.$inferSelect;
export type NewUserRole = typeof userRoles.$inferInsert;
export type RolePermission = typeof rolePermissions.$inferSelect;
export type NewRolePermission = typeof rolePermissions.$inferInsert;
export type AuditLog = typeof auditLogs.$inferSelect;
export type NewAuditLog = typeof auditLogs.$inferInsert;
