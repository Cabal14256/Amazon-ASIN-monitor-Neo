import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

const localTimestamp = sql`LOCALTIMESTAMP`;
const timestampColumn = <TName extends string>(name: TName) =>
  timestamp(name, { mode: 'date', withTimezone: false });

export const competitorVariantGroups = pgTable(
  'competitor_variant_groups',
  {
    id: varchar('id', { length: 50 }).primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    country: varchar('country', { length: 10 }).notNull(),
    brand: varchar('brand', { length: 100 }).notNull(),
    isBroken: boolean('is_broken').default(false),
    variantStatus: varchar('variant_status', { length: 20 }).default('NORMAL'),
    feishuNotifyEnabled: boolean('feishu_notify_enabled').default(false),
    createTime: timestampColumn('create_time').default(localTimestamp),
    updateTime: timestampColumn('update_time').default(localTimestamp),
    lastCheckTime: timestampColumn('last_check_time'),
  },
  (table) => [
    index('idx_competitor_variant_groups_country').on(table.country),
    index('idx_competitor_variant_groups_brand').on(table.brand),
    index('idx_competitor_variant_groups_is_broken').on(table.isBroken),
    index('idx_competitor_variant_groups_create_time').on(table.createTime),
    index('idx_competitor_variant_groups_last_check_time').on(
      table.lastCheckTime,
    ),
    index('idx_competitor_variant_groups_feishu_notify_enabled').on(
      table.feishuNotifyEnabled,
    ),
  ],
);

export const competitorAsins = pgTable(
  'competitor_asins',
  {
    id: varchar('id', { length: 50 }).primaryKey(),
    asin: varchar('asin', { length: 20 }).notNull(),
    name: varchar('name', { length: 500 }),
    asinType: varchar('asin_type', { length: 20 }),
    country: varchar('country', { length: 10 }).notNull(),
    brand: varchar('brand', { length: 100 }).notNull(),
    variantGroupId: varchar('variant_group_id', { length: 50 }).notNull(),
    isBroken: boolean('is_broken').default(false),
    variantStatus: varchar('variant_status', { length: 20 }).default('NORMAL'),
    createTime: timestampColumn('create_time').default(localTimestamp),
    updateTime: timestampColumn('update_time').default(localTimestamp),
    lastCheckTime: timestampColumn('last_check_time'),
    feishuNotifyEnabled: boolean('feishu_notify_enabled').default(false),
  },
  (table) => [
    unique('uk_competitor_asins_asin_country').on(table.asin, table.country),
    foreignKey({
      name: 'fk_competitor_asins_variant_group',
      columns: [table.variantGroupId],
      foreignColumns: [competitorVariantGroups.id],
    }).onDelete('cascade'),
    index('idx_competitor_asins_variant_group_id').on(table.variantGroupId),
    index('idx_competitor_asins_country').on(table.country),
    index('idx_competitor_asins_brand').on(table.brand),
    index('idx_competitor_asins_asin').on(table.asin),
    index('idx_competitor_asins_asin_type').on(table.asinType),
    index('idx_competitor_asins_is_broken').on(table.isBroken),
    index('idx_competitor_asins_last_check_time').on(table.lastCheckTime),
    index('idx_competitor_asins_feishu_notify_enabled').on(
      table.feishuNotifyEnabled,
    ),
    uniqueIndex('uq_competitor_asins_asin_country_ci').on(
      sql`lower(${table.asin})`,
      sql`lower(${table.country})`,
    ),
  ],
);

export const competitorMonitorHistory = pgTable(
  'competitor_monitor_history',
  {
    id: bigint('id', { mode: 'bigint' })
      .generatedAlwaysAsIdentity()
      .primaryKey(),
    variantGroupId: varchar('variant_group_id', { length: 50 }),
    variantGroupName: varchar('variant_group_name', { length: 255 }),
    asinId: varchar('asin_id', { length: 50 }),
    asinCode: varchar('asin_code', { length: 20 }),
    asinName: varchar('asin_name', { length: 500 }),
    checkType: varchar('check_type', { length: 20 }).default('GROUP'),
    country: varchar('country', { length: 10 }).notNull(),
    isBroken: boolean('is_broken').default(false),
    checkTime: timestampColumn('check_time').notNull(),
    checkResult: jsonb('check_result').$type<Record<string, unknown>>(),
    notificationSent: boolean('notification_sent').default(false),
    createTime: timestampColumn('create_time').default(localTimestamp),
  },
  (table) => [
    index('idx_competitor_monitor_history_variant_group_id').on(
      table.variantGroupId,
    ),
    index('idx_competitor_monitor_history_asin_id').on(table.asinId),
    index('idx_competitor_monitor_history_check_time').on(table.checkTime),
    index('idx_competitor_monitor_history_country').on(table.country),
  ],
);

export const competitorFeishuConfig = pgTable(
  'competitor_feishu_config',
  {
    id: integer('id').generatedAlwaysAsIdentity().primaryKey(),
    country: varchar('country', { length: 10 }).notNull().unique(),
    webhookUrl: varchar('webhook_url', { length: 500 }).notNull(),
    enabled: boolean('enabled').default(true),
    createTime: timestampColumn('create_time').default(localTimestamp),
    updateTime: timestampColumn('update_time').default(localTimestamp),
  },
  (table) => [
    uniqueIndex('uq_competitor_feishu_config_country_ci').on(
      sql`lower(${table.country})`,
    ),
  ],
);

export type CompetitorVariantGroup =
  typeof competitorVariantGroups.$inferSelect;
export type NewCompetitorVariantGroup =
  typeof competitorVariantGroups.$inferInsert;
export type CompetitorAsin = typeof competitorAsins.$inferSelect;
export type NewCompetitorAsin = typeof competitorAsins.$inferInsert;
export type CompetitorMonitorHistory =
  typeof competitorMonitorHistory.$inferSelect;
export type NewCompetitorMonitorHistory =
  typeof competitorMonitorHistory.$inferInsert;
export type CompetitorFeishuConfig = typeof competitorFeishuConfig.$inferSelect;
export type NewCompetitorFeishuConfig =
  typeof competitorFeishuConfig.$inferInsert;
