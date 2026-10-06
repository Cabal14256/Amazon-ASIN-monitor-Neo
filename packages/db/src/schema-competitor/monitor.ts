import { sql } from 'drizzle-orm';
import {
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';
import type { CompetitorMonitorGroup } from '../domain/competitor-monitor';

export const competitorMonitorRuns = pgTable(
  'competitor_monitor_runs',
  {
    taskId: varchar('task_id', { length: 36 }).primaryKey(),
    userId: varchar('user_id', { length: 200 }).notNull(),
    taskCreatedAt: varchar('task_created_at', { length: 40 }).notNull(),
    countries: jsonb('countries').$type<string[]>().notNull(),
    groups: jsonb('groups').$type<CompetitorMonitorGroup[]>().notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [
    index('idx_competitor_monitor_runs_expiry').on(t.expiresAt),
    check(
      'ck_competitor_monitor_runs_countries',
      sql`jsonb_typeof(${t.countries})='array' AND jsonb_array_length(${t.countries}) BETWEEN 1 AND 6`,
    ),
    check(
      'ck_competitor_monitor_runs_groups',
      sql`jsonb_typeof(${t.groups})='array' AND jsonb_array_length(${t.groups})<=1000 AND octet_length(${t.groups}::text)<=1048576`,
    ),
  ],
);
export const competitorMonitorNotifications = pgTable(
  'competitor_monitor_notifications',
  {
    taskId: varchar('task_id', { length: 36 })
      .notNull()
      .references(() => competitorMonitorRuns.taskId, { onDelete: 'cascade' }),
    country: varchar('country', { length: 10 }).notNull(),
    state: varchar('state', { length: 16 }).notNull().default('claimed'),
    claimedAt: timestamp('claimed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.country] }),
    check(
      'ck_competitor_monitor_notice_state',
      sql`${t.state} IN ('claimed','sent','failed')`,
    ),
  ],
);
