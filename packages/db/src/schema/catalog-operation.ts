import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import type { CatalogOperationTerminalProof } from '../domain/catalog-operation';

/** No FK to users: account deletion must not erase a live operation fence. */
export const catalogOperationSlots = pgTable(
  'catalog_operation_slots',
  {
    ownerId: varchar('owner_id', { length: 50 }).notNull(),
    domain: varchar('domain', { length: 16 }).notNull(),
    generation: bigint('generation', { mode: 'bigint' }).notNull().default(0n),
    operationId: uuid('operation_id'),
    kind: varchar('kind', { length: 32 }),
    state: varchar('state', { length: 16 }).notNull().default('idle'),
    expectedTaskId: uuid('expected_task_id'),
    taskId: uuid('task_id'),
    taskType: varchar('task_type', { length: 32 }),
    taskSubType: varchar('task_sub_type', { length: 80 }),
    taskCreatedAt: text('task_created_at'),
    terminal: jsonb('terminal').$type<CatalogOperationTerminalProof>(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.domain] }),
    unique('uq_catalog_operation_identity').on(
      table.ownerId,
      table.domain,
      table.generation,
      table.operationId,
    ),
    uniqueIndex('uq_catalog_operation_task').on(table.taskId),
    check('ck_catalog_operation_owner', sql`char_length(${table.ownerId}) > 0`),
    check(
      'ck_catalog_operation_domain',
      sql`${table.domain} IN ('asin','competitor')`,
    ),
    check('ck_catalog_operation_generation', sql`${table.generation} >= 0`),
    check(
      'ck_catalog_operation_state',
      sql`${table.state} IN ('idle','open','closed','uncertain')`,
    ),
    check(
      'ck_catalog_operation_shape',
      sql`(
      (${table.state}='idle' AND ${table.operationId} IS NULL AND ${table.kind} IS NULL
        AND ${table.expectedTaskId} IS NULL AND ${table.taskId} IS NULL AND ${table.terminal} IS NULL)
      OR (${table.state}<>'idle' AND ${table.generation}>0 AND ${table.operationId} IS NOT NULL
        AND ${table.kind} IN ('write','batch-delete','import','check','monitor')
        AND (${table.kind}<>'write' OR ${table.expectedTaskId} IS NULL))
    ) IS TRUE`,
    ),
    check(
      'ck_catalog_operation_task',
      sql`(
      (${table.taskId} IS NULL AND ${table.taskType} IS NULL AND ${
        table.taskSubType
      } IS NULL AND ${table.taskCreatedAt} IS NULL)
      OR (${table.taskId} IS NOT NULL AND ${table.taskId}=${
        table.expectedTaskId
      } AND ${table.taskType} IS NOT NULL
        AND ${table.taskSubType} IS NOT NULL AND ${
        table.taskCreatedAt
      } IS NOT NULL
        AND ${
          table.taskType
        } IN ('batch-delete','import','variant-check','batch-check','monitor','competitor-monitor')
        AND char_length(${table.taskSubType})>0
        AND ${
          table.taskCreatedAt
        } ~ ${String.raw`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$`})
    ) IS TRUE`,
    ),
    check(
      'ck_catalog_operation_terminal',
      sql`(${table.terminal} IS NULL OR (
      ${table.state} IN ('closed','uncertain') AND jsonb_typeof(${table.terminal})='object'
      AND ${table.terminal}->>'status' IN ('completed','failed','cancelled','rejected')
        AND ${table.terminal}->>'source' IN ('sync','worker','cancel','producer')
        AND (${table.terminal}->>'source'<>'producer' OR ${table.terminal}->>'status'='rejected')
        AND (${table.terminal}->>'source'<>'cancel' OR ${table.terminal}->>'status'='cancelled')
        AND ${table.terminal} - ARRAY['status','source','task']='{}'::jsonb
        AND (
          (${table.terminal}->>'source'='sync' AND ${table.taskId} IS NULL AND NOT (${table.terminal} ? 'task'))
          OR (${table.terminal}->>'source'<>'sync' AND ${table.taskId} IS NOT NULL
            AND jsonb_typeof(${table.terminal}->'task')='object'
            AND (${table.terminal}->'task') - ARRAY['taskId','userId','taskType','taskSubType','createdAt']='{}'::jsonb
            AND jsonb_typeof(${table.terminal}->'task'->'taskId')='string' AND ${table.terminal}->'task'->>'taskId'=${table.taskId}::text
            AND jsonb_typeof(${table.terminal}->'task'->'userId')='string' AND ${table.terminal}->'task'->>'userId'=${table.ownerId}
            AND jsonb_typeof(${table.terminal}->'task'->'taskType')='string' AND ${table.terminal}->'task'->>'taskType'=${table.taskType}
            AND jsonb_typeof(${table.terminal}->'task'->'taskSubType')='string' AND ${table.terminal}->'task'->>'taskSubType'=${table.taskSubType}
            AND jsonb_typeof(${table.terminal}->'task'->'createdAt')='string' AND ${table.terminal}->'task'->>'createdAt'=${table.taskCreatedAt})
        )
    )) IS TRUE`,
    ),
  ],
);

/** Durable pins never expire. A lost commit acknowledgement stays uncertain. */
export const catalogOperationPins = pgTable(
  'catalog_operation_pins',
  {
    pinId: uuid('pin_id').primaryKey(),
    ownerId: varchar('owner_id', { length: 50 }).notNull(),
    domain: varchar('domain', { length: 16 }).notNull(),
    generation: bigint('generation', { mode: 'bigint' }).notNull(),
    operationId: uuid('operation_id').notNull(),
    state: varchar('state', { length: 16 }).notNull().default('pending'),
    outcome: varchar('outcome', { length: 16 }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
  },
  (table) => [
    foreignKey({
      name: 'fk_catalog_operation_pin_identity',
      columns: [
        table.ownerId,
        table.domain,
        table.generation,
        table.operationId,
      ],
      foreignColumns: [
        catalogOperationSlots.ownerId,
        catalogOperationSlots.domain,
        catalogOperationSlots.generation,
        catalogOperationSlots.operationId,
      ],
    }).onDelete('restrict'),
    index('idx_catalog_operation_pins_identity').on(
      table.ownerId,
      table.domain,
      table.generation,
      table.operationId,
    ),
    check(
      'ck_catalog_operation_pin_state',
      sql`${table.state} IN ('pending','settled','uncertain')`,
    ),
    check(
      'ck_catalog_operation_pin_shape',
      sql`(
      (${table.state}='pending' AND ${table.outcome} IS NULL AND ${table.settledAt} IS NULL)
      OR (${table.state}='uncertain' AND ${table.outcome} IS NULL AND ${table.settledAt} IS NOT NULL)
      OR (${table.state}='settled' AND ${table.outcome} IN ('committed','rolled-back') AND ${table.settledAt} IS NOT NULL)
    ) IS TRUE`,
    ),
  ],
);
