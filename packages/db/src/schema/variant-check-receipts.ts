import { sql } from 'drizzle-orm';
import { check, index, jsonb, pgTable, varchar } from 'drizzle-orm/pg-core';
import { shanghaiTimestamp } from '../timestamps';

/** Neo-only transactional completion records; deliberately separate from the
 * immutable Legacy import baseline. Installed by primary upgrade 0006. */
export const variantCheckReceipts = pgTable(
  'variant_check_receipts',
  {
    operationKey: varchar('operation_key', { length: 64 }).primaryKey(),
    requestHash: varchar('request_hash', { length: 64 }).notNull(),
    taskId: varchar('task_id', { length: 200 }).notNull(),
    userId: varchar('user_id', { length: 200 }).notNull(),
    taskCreatedAt: varchar('task_created_at', { length: 40 }).notNull(),
    taskType: varchar('task_type', { length: 100 }).notNull(),
    taskSubType: varchar('task_sub_type', { length: 200 }).notNull(),
    step: varchar('step', { length: 32 }).notNull(),
    resultKind: varchar('result_kind', { length: 16 }).notNull(),
    result: jsonb('result').$type<unknown>().notNull(),
    completedAt: shanghaiTimestamp('completed_at')
      .notNull()
      .default(sql`LOCALTIMESTAMP`),
    expiresAt: shanghaiTimestamp('expires_at').notNull(),
  },
  (table) => [
    index('idx_variant_check_receipts_task_owner').on(
      table.taskId,
      table.userId,
      table.taskCreatedAt,
    ),
    index('idx_variant_check_receipts_expiry').on(table.expiresAt),
    check(
      'ck_variant_check_receipts_digest',
      sql`${table.operationKey} ~ '^[a-f0-9]{64}$' AND ${table.requestHash} ~ '^[a-f0-9]{64}$'`,
    ),
    check(
      'ck_variant_check_receipts_size',
      sql`octet_length(${table.result}::text) BETWEEN 1 AND 33554432`,
    ),
    check(
      'ck_variant_check_receipts_kind',
      sql`${table.resultKind} IN ('asin','group','parent','batch')`,
    ),
  ],
);
