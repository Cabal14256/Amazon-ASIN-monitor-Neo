import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';

export const monitorIntervalDirty = pgTable(
  'monitor_interval_dirty',
  {
    asinKey: varchar('asin_key', { length: 53 }).notNull(),
    country: varchar('country', { length: 10 }).notNull(),
    revision: bigint('revision', { mode: 'bigint' })
      .notNull()
      .default(sql`1`),
    completedRevision: bigint('completed_revision', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
    active: boolean('active').notNull().default(false),
    firstCheckTime: timestamp('first_check_time'),
    lastCheckTime: timestamp('last_check_time'),
    sourceRelationIds: bigint('source_relation_ids', { mode: 'number' })
      .array()
      .notNull()
      .default(sql`'{}'`),
    queuedAt: timestamp('queued_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    retryAfter: timestamp('retry_after', { withTimezone: true })
      .notNull()
      .default(sql`'-infinity'`),
  },
  (table) => [
    primaryKey({ columns: [table.asinKey, table.country] }),
    index('idx_monitor_interval_dirty_queue')
      .on(table.queuedAt, table.asinKey, table.country)
      .where(sql`${table.completedRevision} <> ${table.revision}`),
  ],
);

export const monitorIntervalProjection = pgTable(
  'monitor_interval_projection',
  {
    singleton: boolean('singleton').primaryKey().default(true),
    version: integer('version').notNull(),
    initializedAt: timestamp('initialized_at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
  },
  (table) => [
    check(
      'monitor_interval_projection_singleton_check',
      sql`${table.singleton}`,
    ),
  ],
);
