import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  timestamp,
  unique,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';

/** Private system ledgers never reference an application user or session. Each
 * logical database installs only its own domain's tables with upgrade 0016. */
export function scheduledMonitorTables(domain: 'primary' | 'competitor') {
  const prefix = `${domain}_scheduled_monitor`;
  const instant = (name: string) => timestamp(name, { withTimezone: true });
  const runs = pgTable(
    `${prefix}_runs`,
    {
      taskId: uuid('task_id').primaryKey(),
      jobId: varchar('job_id', { length: 200 }).notNull(),
      jobDigest: varchar('job_digest', { length: 64 }).notNull(),
      job: jsonb('job').$type<unknown>().notNull(),
      domain: varchar('domain', { length: 16 }).notNull(),
      actorKind: varchar('actor_kind', { length: 16 })
        .notNull()
        .default('system'),
      actorPurpose: varchar('actor_purpose', { length: 32 })
        .notNull()
        .default('scheduled-monitor'),
      country: varchar('country', { length: 2 }).notNull(),
      plannedSlot: instant('planned_slot').notNull(),
      requestedAt: instant('requested_at').notNull(),
      createdAt: instant('created_at').notNull(),
      expiresAt: instant('expires_at').notNull(),
      intervalMinutes: integer('interval_minutes').notNull(),
      batchIndex: integer('batch_index').notNull(),
      totalBatches: integer('total_batches').notNull(),
      groups: jsonb('groups').$type<unknown>().notNull(),
      snapshotDigest: varchar('snapshot_digest', { length: 64 }).notNull(),
      totalMembers: integer('total_members').notNull(),
      state: varchar('state', { length: 24 }).notNull().default('pending'),
      businessCompletedAt: instant('business_completed_at'),
      completedAt: instant('completed_at'),
      cancelRequestedAt: instant('cancel_requested_at'),
      result: jsonb('result').$type<unknown>(),
      followUpJob: jsonb('follow_up_job').$type<unknown>(),
      followUpDigest: varchar('follow_up_digest', { length: 64 }),
      followUpRequestedAt: instant('follow_up_requested_at'),
    },
    (table) => [
      unique(`uq_${prefix}_job`).on(table.jobId),
      unique(`uq_${prefix}_identity`).on(
        table.taskId,
        table.jobDigest,
        table.country,
      ),
      index(`idx_${prefix}_expiry`).on(table.expiresAt, table.taskId),
      check(
        `ck_${prefix}_actor`,
        sql`${table.domain} = ${domain} AND ${table.actorKind} = 'system' AND ${table.actorPurpose} = 'scheduled-monitor'`,
      ),
      check(
        `ck_${prefix}_country`,
        sql`${table.country} IN ('US','UK','DE','FR','ES','IT')`,
      ),
      check(
        `ck_${prefix}_digest`,
        sql`${table.jobDigest} ~ '^[a-f0-9]{64}$' AND ${table.snapshotDigest} ~ '^[a-f0-9]{64}$'`,
      ),
      check(
        `ck_${prefix}_job`,
        sql`jsonb_typeof(${table.job}) = 'object' AND octet_length(${table.job}::text) <= 16384 AND NOT (${table.job} ? 'userId') AND ${table.job} @> jsonb_build_object('version',1,'source','scheduled','taskType','scheduled-monitor','actor',jsonb_build_object('kind','system','purpose','scheduled-monitor'),'domain',${table.domain},'country',${table.country},'taskId',${table.taskId}::text,'jobId',${table.jobId},'intervalMinutes',${table.intervalMinutes},'batchConfig',jsonb_build_object('batchIndex',${table.batchIndex},'totalBatches',${table.totalBatches})) AND ${table.job}->>'plannedSlot' IS NOT NULL AND (${table.job}->>'plannedSlot')::timestamptz = ${table.plannedSlot} AND ${table.job}->>'requestedAt' IS NOT NULL AND (${table.job}->>'requestedAt')::timestamptz = ${table.requestedAt} AND ${table.job}->>'createdAt' IS NOT NULL AND (${table.job}->>'createdAt')::timestamptz = ${table.createdAt} AND ${table.job}->>'expiresAt' IS NOT NULL AND (${table.job}->>'expiresAt')::timestamptz = ${table.expiresAt}`,
      ),
      check(
        `ck_${prefix}_time`,
        sql`${table.plannedSlot} = (date_trunc('minute',${table.plannedSlot} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC') AND ${table.requestedAt} >= ${table.plannedSlot} AND ${table.createdAt} >= ${table.requestedAt} AND ${table.expiresAt} > ${table.createdAt}`,
      ),
      check(
        `ck_${prefix}_batch`,
        sql`${table.intervalMinutes} IN (15,30,60) AND ${table.totalBatches} BETWEEN 1 AND 1000 AND ${table.batchIndex} >= 0 AND ${table.batchIndex} < ${table.totalBatches} AND ${table.batchIndex} = mod(mod(floor(extract(epoch FROM ${table.plannedSlot}) / (${table.intervalMinutes} * 60))::bigint,${table.totalBatches}) + ${table.totalBatches},${table.totalBatches})`,
      ),
      check(
        `ck_${prefix}_snapshot`,
        sql`jsonb_typeof(${table.groups}) = 'array' AND jsonb_array_length(${table.groups}) <= 1000 AND octet_length(${table.groups}::text) <= 16777216 AND ${table.totalMembers} BETWEEN 0 AND 20000`,
      ),
      check(
        `ck_${prefix}_state`,
        sql`${table.state} IN ('pending','running','business-completed','completed','skipped-expired','cancelled','failed')`,
      ),
      check(
        `ck_${prefix}_completion`,
        sql`((${table.state} IN ('completed','skipped-expired','cancelled','failed') AND ${table.completedAt} IS NOT NULL) OR (${table.state} IN ('pending','running','business-completed') AND ${table.completedAt} IS NULL)) AND (${table.state} NOT IN ('business-completed','completed') OR ${table.businessCompletedAt} IS NOT NULL) AND (${table.businessCompletedAt} IS NULL OR (${table.businessCompletedAt} >= ${table.createdAt} AND ${table.state} IN ('business-completed','completed','cancelled','failed'))) AND (${table.completedAt} IS NULL OR (${table.completedAt} >= ${table.createdAt} AND (${table.businessCompletedAt} IS NULL OR ${table.completedAt} >= ${table.businessCompletedAt})))`,
      ),
      check(
        `ck_${prefix}_result`,
        sql`${table.result} IS NULL OR octet_length(${table.result}::text) BETWEEN 1 AND 33554432`,
      ),
      check(
        `ck_${prefix}_follow_up`,
        sql`(${table.followUpJob} IS NULL AND ${table.followUpDigest} IS NULL AND ${table.followUpRequestedAt} IS NULL) OR (${table.domain} = 'primary' AND ${table.country} = 'US' AND ${table.businessCompletedAt} IS NOT NULL AND ${table.followUpJob} IS NOT NULL AND jsonb_typeof(${table.followUpJob}) = 'object' AND octet_length(${table.followUpJob}::text) <= 16384 AND NOT (${table.followUpJob} ? 'userId') AND ${table.followUpJob} @> '{"version":1,"source":"scheduled","taskType":"scheduled-monitor","actor":{"kind":"system","purpose":"scheduled-monitor"},"domain":"competitor","country":"US"}'::jsonb AND ${table.followUpJob} @> jsonb_build_object('plannedSlot',${table.job}->>'plannedSlot','intervalMinutes',${table.intervalMinutes},'batchConfig',jsonb_build_object('batchIndex',${table.batchIndex},'totalBatches',${table.totalBatches})) AND ${table.followUpDigest} IS NOT NULL AND ${table.followUpDigest} ~ '^[a-f0-9]{64}$' AND ${table.followUpRequestedAt} IS NOT NULL AND ${table.followUpJob}->>'requestedAt' IS NOT NULL AND (${table.followUpJob}->>'requestedAt')::timestamptz = ${table.followUpRequestedAt} AND ${table.followUpRequestedAt} >= ${table.businessCompletedAt})`,
      ),
    ],
  );
  const notifications = pgTable(
    `${prefix}_notifications`,
    {
      taskId: uuid('task_id').notNull(),
      jobDigest: varchar('job_digest', { length: 64 }).notNull(),
      country: varchar('country', { length: 2 }).notNull(),
      state: varchar('state', { length: 16 }).notNull().default('claimed'),
      claimedAt: instant('claimed_at').notNull().defaultNow(),
      completedAt: instant('completed_at'),
    },
    (table) => [
      primaryKey({
        name: `${prefix}_notifications_pkey`,
        columns: [table.taskId, table.country],
      }),
      foreignKey({
        name: `fk_${prefix}_notice_run`,
        columns: [table.taskId, table.jobDigest, table.country],
        foreignColumns: [runs.taskId, runs.jobDigest, runs.country],
      }).onDelete('cascade'),
      check(
        `ck_${prefix}_notice_state`,
        sql`(${table.state} = 'claimed' AND ${table.completedAt} IS NULL) OR (${table.state} IN ('sent','failed') AND ${table.completedAt} IS NOT NULL)`,
      ),
    ],
  );
  const groupReceipts = pgTable(
    `${prefix}_group_receipts`,
    {
      operationKey: varchar('operation_key', { length: 64 }).primaryKey(),
      requestHash: varchar('request_hash', { length: 64 }).notNull(),
      taskId: uuid('task_id').notNull(),
      jobDigest: varchar('job_digest', { length: 64 }).notNull(),
      country: varchar('country', { length: 2 }).notNull(),
      groupId: varchar('group_id', { length: 50 }).notNull(),
      ordinal: integer('ordinal').notNull(),
      snapshotDigest: varchar('snapshot_digest', { length: 64 }).notNull(),
      resultKind: varchar('result_kind', { length: 16 }).notNull(),
      result: jsonb('result').$type<unknown>().notNull(),
      completedAt: instant('completed_at').notNull().defaultNow(),
    },
    (table) => [
      unique(`uq_${prefix}_group_ordinal`).on(table.taskId, table.ordinal),
      unique(`uq_${prefix}_group_id`).on(table.taskId, table.groupId),
      foreignKey({
        name: `fk_${prefix}_group_run`,
        columns: [table.taskId, table.jobDigest, table.country],
        foreignColumns: [runs.taskId, runs.jobDigest, runs.country],
      }).onDelete('cascade'),
      check(
        `ck_${prefix}_group_digest`,
        sql`${table.operationKey} ~ '^[a-f0-9]{64}$' AND ${table.requestHash} ~ '^[a-f0-9]{64}$' AND ${table.snapshotDigest} ~ '^[a-f0-9]{64}$'`,
      ),
      check(
        `ck_${prefix}_group_ordinal`,
        sql`${table.ordinal} BETWEEN 0 AND 999`,
      ),
      check(
        `ck_${prefix}_group_kind`,
        sql`${table.resultKind} = ${
          domain === 'primary' ? 'group' : 'competitor-group'
        }`,
      ),
      check(
        `ck_${prefix}_group_size`,
        sql`octet_length(${table.result}::text) BETWEEN 1 AND 33554432`,
      ),
    ],
  );
  return { runs, notifications, groupReceipts };
}
