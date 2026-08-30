import { randomUUID } from 'node:crypto';

import {
  dataMigrationReportSchema,
  dataMigrationRunIdSchema,
  type DataMigrationDatabaseReport,
  type DataMigrationQueryReport,
  type DataMigrationReport,
  type DataMigrationTableReport,
} from '@asin-monitor/contracts';
import mysql, {
  type Connection as MysqlConnection,
  type RowDataPacket,
} from 'mysql2/promise';
import {
  types as pgTypes,
  type Pool,
  type PoolClient,
  type PoolConfig,
} from 'pg';

import { createPgPool } from '../client';
import {
  canonicalMultisetDigest,
  DeterministicSampler,
  parseMigrationJsonDocument,
  sha256,
  transformSourceRow,
  type MigrationRow,
} from './canonical';
import {
  validateDataMigrationConfig,
  type DataMigrationConfig,
} from './config';
import { asDataMigrationError, DataMigrationError } from './errors';
import { createMigrationLogger, type MigrationLogger } from './logger';
import {
  databaseMigrationSpecs,
  normalizeMysqlGeneratedExpression,
  normalizePostgresCheckExpression,
  normalizePostgresExpression,
  normalizePostgresRoutineDefinition,
  type DatabaseMigrationSpec,
  type MigrationDatabaseName,
  type SourceKeysetColumn,
  type TableMigrationSpec,
} from './registry';

interface DatabaseContext {
  readonly spec: DatabaseMigrationSpec;
  readonly sourceDatabase: string;
  readonly source: MysqlConnection;
  readonly targetPool: Pool;
  readonly target: PoolClient;
  sourceTransactionOpen: boolean;
  targetTransactionOpen: boolean;
  targetCommitAttempted: boolean;
  targetCommitted: boolean;
}

const safeIdentifierPattern = /^[a-z][a-z0-9_]*$/;
const legacyBackupTablePatterns = [
  /^(?:mh|mha|mhad|mhavg)_bak_\d{8}_\d{6}$/,
  /^monitor_history_(?:agg|agg_dim|agg_variant_group|status_interval)_bak_\d{8}_\d{6}$/,
] as const;
const stringPgTypeOids = new Set([20, 1114]); // int8, timestamp without time zone
const losslessJsonPgTypeOids = new Set([114, 3802]); // json, jsonb
const migrationPgTypes: NonNullable<PoolConfig['types']> = {
  getTypeParser(oid, format = 'text') {
    if (format === 'text' && losslessJsonPgTypeOids.has(oid)) {
      return parseMigrationJsonDocument;
    }
    if (format === 'text' && stringPgTypeOids.has(oid)) {
      return (value: string) => value;
    }
    return pgTypes.getTypeParser(oid, format);
  },
};

function quoteMysqlIdentifier(value: string): string {
  if (!safeIdentifierPattern.test(value)) {
    throw new DataMigrationError(
      'MIGRATION_REGISTRY_INVALID',
      'registry.identifier',
      'migration registry contains an unsafe identifier',
    );
  }
  return `\`${value}\``;
}

function quotePgIdentifier(value: string): string {
  if (!safeIdentifierPattern.test(value)) {
    throw new DataMigrationError(
      'MIGRATION_REGISTRY_INVALID',
      'registry.identifier',
      'migration registry contains an unsafe identifier',
    );
  }
  return `"${value}"`;
}

export function isAllowedLegacyBackupTableName(value: string): boolean {
  return legacyBackupTablePatterns.some((pattern) => pattern.test(value));
}

function exactCount(value: unknown, scope: string): string {
  const normalized = String(value);
  if (!/^(0|[1-9]\d*)$/.test(normalized)) {
    throw new DataMigrationError(
      'COUNT_INVALID',
      scope,
      `database returned an invalid row count for ${scope}`,
    );
  }
  return normalized;
}

async function mysqlRows(
  connection: MysqlConnection,
  sql: string,
  parameters: readonly unknown[] = [],
): Promise<MigrationRow[]> {
  const [rows] = await connection.execute<RowDataPacket[]>(sql, parameters);
  return rows as unknown as MigrationRow[];
}

function compareExactSet(
  expected: readonly string[],
  actual: readonly string[],
  code: string,
  scope: string,
): void {
  const expectedSorted = [...expected].sort();
  const actualSorted = [...actual].sort();
  if (JSON.stringify(expectedSorted) === JSON.stringify(actualSorted)) return;

  const missingCount = expectedSorted.filter(
    (value) => !actualSorted.includes(value),
  ).length;
  const extraCount = actualSorted.filter(
    (value) => !expectedSorted.includes(value),
  ).length;
  throw new DataMigrationError(
    code,
    scope,
    `${scope} mismatch (expected_count: ${
      expectedSorted.length
    }; actual_count: ${
      actualSorted.length
    }; missing_count: ${missingCount}; extra_count: ${extraCount}; expected_fingerprint: ${sha256(
      expectedSorted,
    )}; actual_fingerprint: ${sha256(actualSorted)})`,
  );
}

function redactSqlStringLiterals(value: string): string {
  return value.replace(/'(?:''|[^'])*'/g, "'[REDACTED]'");
}

async function validateSourceSchema(context: DatabaseContext): Promise<void> {
  const tableRows = await mysqlRows(
    context.source,
    `
      SELECT
        TABLE_NAME AS table_name,
        ENGINE AS engine
      FROM information_schema.tables
      WHERE table_schema = ?
        AND table_type = 'BASE TABLE'
      ORDER BY table_name
    `,
    [context.sourceDatabase],
  );
  const expectedTableNames = context.spec.tables.map(({ name }) => name);
  const expectedTableSet = new Set(expectedTableNames);
  const sourceTableNames = tableRows.map(({ table_name }) =>
    String(table_name),
  );
  compareExactSet(
    expectedTableNames,
    sourceTableNames.filter(
      (tableName) => !isAllowedLegacyBackupTableName(tableName),
    ),
    'SOURCE_SCHEMA_MISMATCH',
    `${context.spec.logicalName}.source.tables`,
  );
  const nonTransactionalTables = tableRows
    .filter(
      ({ table_name, engine }) =>
        expectedTableSet.has(String(table_name)) &&
        String(engine).toLowerCase() !== 'innodb',
    )
    .map(({ table_name }) => String(table_name));
  if (nonTransactionalTables.length > 0) {
    throw new DataMigrationError(
      'SOURCE_ENGINE_UNSUPPORTED',
      `${context.spec.logicalName}.source.engines`,
      `consistent snapshot requires InnoDB tables (unsupported: ${nonTransactionalTables.join(
        ',',
      )})`,
    );
  }

  const columnRows = await mysqlRows(
    context.source,
    `
      SELECT
        TABLE_NAME AS table_name,
        COLUMN_NAME AS column_name,
        LOWER(COLUMN_TYPE) AS column_type,
        EXTRA AS extra,
        COALESCE(GENERATION_EXPRESSION, '') AS generation_expression
      FROM information_schema.columns
      WHERE table_schema = ?
      ORDER BY table_name, ordinal_position
    `,
    [context.sourceDatabase],
  );
  for (const table of context.spec.tables) {
    compareExactSet(
      table.columns,
      columnRows
        .filter(({ table_name }) => table_name === table.name)
        .map(({ column_name }) => String(column_name)),
      'SOURCE_SCHEMA_MISMATCH',
      `${context.spec.logicalName}.source.${table.name}`,
    );
    compareExactSet(
      table.sourceColumnTypeSignatures,
      columnRows
        .filter(({ table_name }) => table_name === table.name)
        .map(({ column_name, column_type }) =>
          [String(column_name), String(column_type)].join('|'),
        ),
      'SOURCE_SCHEMA_MISMATCH',
      `${context.spec.logicalName}.source.${table.name}.column_types`,
    );

    const expectedGeneratedColumns = new Map(
      table.sourceGeneratedColumns.map(({ column, expressions }) => [
        column,
        expressions,
      ]),
    );
    const actualGeneratedColumns = columnRows.filter(
      ({ table_name, extra, generation_expression }) =>
        table_name === table.name &&
        (/\b(?:stored|virtual) generated\b/i.test(String(extra)) ||
          String(generation_expression).trim().length > 0),
    );
    compareExactSet(
      [...expectedGeneratedColumns.keys()],
      actualGeneratedColumns.map(({ column_name }) => String(column_name)),
      'SOURCE_SCHEMA_MISMATCH',
      `${context.spec.logicalName}.source.${table.name}.generated_columns`,
    );
    for (const generatedColumn of actualGeneratedColumns) {
      const columnName = String(generatedColumn.column_name);
      const acceptedExpressions = expectedGeneratedColumns.get(columnName);
      const normalizedExpression = normalizeMysqlGeneratedExpression(
        String(generatedColumn.generation_expression),
      );
      if (
        !/\bstored generated\b/i.test(String(generatedColumn.extra)) ||
        !acceptedExpressions?.includes(normalizedExpression)
      ) {
        throw new DataMigrationError(
          'SOURCE_SCHEMA_MISMATCH',
          `${context.spec.logicalName}.source.${table.name}.generated_columns`,
          `source generated column definition mismatch for ${
            table.name
          }.${columnName} (structure: ${redactSqlStringLiterals(
            normalizedExpression,
          )}; fingerprint: ${sha256(normalizedExpression)})`,
        );
      }
    }
  }

  const primaryKeyRows = await mysqlRows(
    context.source,
    `
      SELECT
        TABLE_NAME AS table_name,
        COLUMN_NAME AS column_name,
        SEQ_IN_INDEX AS sequence_in_index
      FROM information_schema.statistics
      WHERE table_schema = ?
        AND index_name = 'PRIMARY'
      ORDER BY table_name, sequence_in_index
    `,
    [context.sourceDatabase],
  );
  for (const table of context.spec.tables) {
    compareExactSet(
      table.primaryKeyColumns.map((column, index) => `${index + 1}|${column}`),
      primaryKeyRows
        .filter(({ table_name }) => table_name === table.name)
        .map(
          ({ sequence_in_index, column_name }) =>
            `${String(sequence_in_index)}|${String(column_name)}`,
        ),
      'SOURCE_SCHEMA_MISMATCH',
      `${context.spec.logicalName}.source.${table.name}.primary_key`,
    );
  }
}

async function validateTargetEnvironment(
  context: DatabaseContext,
): Promise<void> {
  const sessionResult = await context.target.query<{
    client_encoding: string;
    replication_role: string;
  }>(`
    SELECT
      current_setting('client_encoding') AS client_encoding,
      current_setting('session_replication_role') AS replication_role
  `);
  compareExactSet(
    ['UTF8|origin'],
    sessionResult.rows.map(
      ({ client_encoding, replication_role }) =>
        `${client_encoding}|${replication_role}`,
    ),
    'TARGET_SESSION_MISMATCH',
    `${context.spec.logicalName}.target.session`,
  );

  const databaseResult = await context.target.query<{ encoding: string }>(`
    SELECT pg_encoding_to_char(encoding) AS encoding
    FROM pg_database
    WHERE datname = current_database()
  `);
  compareExactSet(
    ['UTF8'],
    databaseResult.rows.map(({ encoding }) => encoding),
    'TARGET_DATABASE_ENCODING_MISMATCH',
    `${context.spec.logicalName}.target.database_encoding`,
  );
}

async function validateTargetSchema(context: DatabaseContext): Promise<void> {
  const tableResult = await context.target.query<{
    table_name: string;
    persistence: string;
    row_security: boolean;
    force_row_security: boolean;
  }>(`
    SELECT
      relation.relname AS table_name,
      relation.relpersistence AS persistence,
      relation.relrowsecurity AS row_security,
      relation.relforcerowsecurity AS force_row_security
    FROM pg_class relation
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
    ORDER BY relation.relname
  `);
  compareExactSet(
    context.spec.tables.map(({ name }) => `${name}|p|rls-off|force-rls-off`),
    tableResult.rows.map(
      ({ table_name, persistence, row_security, force_row_security }) =>
        [
          table_name,
          persistence,
          row_security ? 'rls-on' : 'rls-off',
          force_row_security ? 'force-rls-on' : 'force-rls-off',
        ].join('|'),
    ),
    'TARGET_SCHEMA_MISMATCH',
    `${context.spec.logicalName}.target.tables`,
  );

  const columnResult = await context.target.query<{
    table_name: string;
    column_name: string;
    data_type: string;
    is_not_null: boolean;
    identity_kind: string;
    generated_kind: string;
    stored_expression: string | null;
    collation_kind: string;
  }>(`
    SELECT
      relation.relname AS table_name,
      attribute.attname AS column_name,
      format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
      attribute.attnotnull AS is_not_null,
      attribute.attidentity AS identity_kind,
      attribute.attgenerated AS generated_kind,
      pg_get_expr(attribute_default.adbin, attribute_default.adrelid, true)
        AS stored_expression,
      CASE
        WHEN attribute.attcollation = 0 THEN 'none'
        WHEN attribute.attcollation = 'default'::regcollation::oid
          AND collation_row.collisdeterministic
          THEN 'default-deterministic'
        ELSE 'non-default-or-nondeterministic'
      END AS collation_kind
    FROM pg_attribute attribute
    JOIN pg_class relation ON relation.oid = attribute.attrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    LEFT JOIN pg_attrdef attribute_default
      ON attribute_default.adrelid = attribute.attrelid
     AND attribute_default.adnum = attribute.attnum
    LEFT JOIN pg_collation collation_row
      ON collation_row.oid = attribute.attcollation
    WHERE namespace.nspname = 'public'
      AND relation.relkind IN ('r', 'p')
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    ORDER BY relation.relname, attribute.attnum
  `);
  for (const table of context.spec.tables) {
    compareExactSet(
      table.targetColumnSignatures,
      columnResult.rows
        .filter(({ table_name }) => table_name === table.name)
        .map(
          ({
            column_name,
            data_type,
            is_not_null,
            identity_kind,
            generated_kind,
            stored_expression,
            collation_kind,
          }) =>
            [
              column_name,
              data_type,
              is_not_null ? 'not-null' : 'nullable',
              identity_kind,
              generated_kind,
              normalizePostgresExpression(stored_expression ?? '', table.name),
              collation_kind,
            ].join('|'),
        ),
      'TARGET_SCHEMA_MISMATCH',
      `${context.spec.logicalName}.target.${table.name}.columns`,
    );
  }

  const sequenceResult = await context.target.query<{
    table_name: string;
    column_name: string;
    sequence_schema: string;
    sequence_name: string;
    persistence: string;
    data_type: string;
    start_value: string;
    increment_value: string;
    minimum_value: string;
    maximum_value: string;
    cache_size: string;
    cycles: boolean;
  }>(`
    SELECT
      table_relation.relname AS table_name,
      attribute.attname AS column_name,
      sequence_namespace.nspname AS sequence_schema,
      sequence_relation.relname AS sequence_name,
      sequence_relation.relpersistence AS persistence,
      format_type(sequence_row.seqtypid, NULL) AS data_type,
      sequence_row.seqstart::text AS start_value,
      sequence_row.seqincrement::text AS increment_value,
      sequence_row.seqmin::text AS minimum_value,
      sequence_row.seqmax::text AS maximum_value,
      sequence_row.seqcache::text AS cache_size,
      sequence_row.seqcycle AS cycles
    FROM pg_class table_relation
    JOIN pg_namespace table_namespace
      ON table_namespace.oid = table_relation.relnamespace
    JOIN pg_attribute attribute
      ON attribute.attrelid = table_relation.oid
     AND attribute.attidentity IN ('a', 'd')
    CROSS JOIN LATERAL (
      SELECT pg_get_serial_sequence(
        format('%I.%I', table_namespace.nspname, table_relation.relname),
        attribute.attname
      )::regclass::oid AS sequence_oid
    ) identity_sequence
    JOIN pg_class sequence_relation
      ON sequence_relation.oid = identity_sequence.sequence_oid
     AND sequence_relation.relkind = 'S'
    JOIN pg_namespace sequence_namespace
      ON sequence_namespace.oid = sequence_relation.relnamespace
    JOIN pg_sequence sequence_row
      ON sequence_row.seqrelid = sequence_relation.oid
    WHERE table_namespace.nspname = 'public'
    ORDER BY table_relation.relname, attribute.attnum
  `);
  for (const table of context.spec.tables) {
    compareExactSet(
      table.targetSequenceSignatures,
      sequenceResult.rows
        .filter(({ table_name }) => table_name === table.name)
        .map((sequence) =>
          [
            sequence.column_name,
            sequence.sequence_schema,
            sequence.sequence_name,
            sequence.persistence,
            sequence.data_type,
            sequence.start_value,
            sequence.increment_value,
            sequence.minimum_value,
            sequence.maximum_value,
            sequence.cache_size,
            sequence.cycles ? 'cycle' : 'no-cycle',
          ].join('|'),
        ),
      'TARGET_SCHEMA_MISMATCH',
      `${context.spec.logicalName}.target.${table.name}.sequences`,
    );
  }

  const constraintResult = await context.target.query<{
    table_name: string;
    constraint_name: string;
    constraint_type: 'p' | 'u' | 'f' | 'c';
    columns: string[];
    foreign_schema: string | null;
    foreign_table: string | null;
    foreign_columns: string[];
    update_action: string;
    delete_action: string;
    check_expression: string | null;
    is_deferrable: boolean;
    is_initially_deferred: boolean;
  }>(`
    SELECT
      relation.relname AS table_name,
      constraint_row.conname AS constraint_name,
      constraint_row.contype AS constraint_type,
      ARRAY(
        SELECT attribute.attname::text
        FROM unnest(constraint_row.conkey) WITH ORDINALITY AS key(attnum, position)
        JOIN pg_attribute attribute
          ON attribute.attrelid = constraint_row.conrelid
         AND attribute.attnum = key.attnum
        ORDER BY key.position
      ) AS columns,
      foreign_namespace.nspname AS foreign_schema,
      foreign_relation.relname AS foreign_table,
      CASE WHEN constraint_row.contype = 'f' THEN ARRAY(
        SELECT attribute.attname::text
        FROM unnest(constraint_row.confkey) WITH ORDINALITY AS key(attnum, position)
        JOIN pg_attribute attribute
          ON attribute.attrelid = constraint_row.confrelid
         AND attribute.attnum = key.attnum
        ORDER BY key.position
      ) ELSE ARRAY[]::text[] END AS foreign_columns,
      constraint_row.confupdtype AS update_action,
      constraint_row.confdeltype AS delete_action,
      constraint_row.condeferrable AS is_deferrable,
      constraint_row.condeferred AS is_initially_deferred,
      CASE WHEN constraint_row.contype = 'c'
        THEN pg_get_expr(constraint_row.conbin, constraint_row.conrelid, true)
        ELSE NULL
      END AS check_expression
    FROM pg_constraint constraint_row
    JOIN pg_class relation ON relation.oid = constraint_row.conrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    LEFT JOIN pg_class foreign_relation
      ON foreign_relation.oid = constraint_row.confrelid
    LEFT JOIN pg_namespace foreign_namespace
      ON foreign_namespace.oid = foreign_relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND constraint_row.contype IN ('p', 'u', 'f', 'c')
    ORDER BY relation.relname, constraint_row.conname
  `);
  const actionName = (action: string): string => {
    const names: Record<string, string> = {
      a: 'no action',
      r: 'restrict',
      c: 'cascade',
      n: 'set null',
      d: 'set default',
    };
    return names[action] ?? action;
  };
  for (const table of context.spec.tables) {
    compareExactSet(
      table.targetConstraintSignatures,
      constraintResult.rows
        .filter(({ table_name }) => table_name === table.name)
        .map((constraint) => {
          if (constraint.constraint_type === 'c') {
            return `c|${
              constraint.constraint_name
            }|${normalizePostgresCheckExpression(
              constraint.check_expression ?? '',
              table.name,
            )}`;
          }
          if (constraint.constraint_type === 'f') {
            return [
              'f',
              constraint.constraint_name,
              constraint.columns.join(','),
              constraint.foreign_schema ?? '',
              constraint.foreign_table ?? '',
              constraint.foreign_columns.join(','),
              actionName(constraint.update_action),
              actionName(constraint.delete_action),
              constraint.is_deferrable ? 'deferrable' : 'not-deferrable',
              constraint.is_initially_deferred
                ? 'initially-deferred'
                : 'initially-immediate',
            ].join('|');
          }
          return [
            constraint.constraint_type,
            constraint.constraint_name,
            constraint.columns.join(','),
            constraint.is_deferrable ? 'deferrable' : 'not-deferrable',
            constraint.is_initially_deferred
              ? 'initially-deferred'
              : 'initially-immediate',
          ].join('|');
        }),
      'TARGET_SCHEMA_MISMATCH',
      `${context.spec.logicalName}.target.${table.name}.constraints`,
    );
  }

  const indexResult = await context.target.query<{
    table_name: string;
    index_name: string;
    is_unique: boolean;
    access_method: string;
    expressions: string[];
    predicate: string;
    is_valid: boolean;
    is_ready: boolean;
    referenced_functions: string[];
  }>(`
    SELECT
      table_relation.relname AS table_name,
      index_relation.relname AS index_name,
      index_row.indisunique AS is_unique,
      access_method.amname AS access_method,
      ARRAY(
        SELECT pg_get_indexdef(index_row.indexrelid, position, true)
        FROM generate_series(1, index_row.indnkeyatts) AS position
        ORDER BY position
      ) AS expressions,
      COALESCE(pg_get_expr(index_row.indpred, index_row.indrelid, true), '') AS predicate,
      index_row.indisvalid AS is_valid,
      index_row.indisready AS is_ready,
      ARRAY(
        SELECT function_signature
        FROM (
          SELECT DISTINCT
            function_namespace.nspname || '.' ||
            function_row.proname || '(' ||
            pg_get_function_identity_arguments(function_row.oid) || ')'
              AS function_signature
          FROM pg_depend dependency
          JOIN pg_proc function_row
            ON dependency.refclassid = 'pg_proc'::regclass
           AND dependency.refobjid = function_row.oid
          JOIN pg_namespace function_namespace
            ON function_namespace.oid = function_row.pronamespace
          WHERE dependency.classid = 'pg_class'::regclass
            AND dependency.objid = index_row.indexrelid
        ) referenced_function
        ORDER BY function_signature
      ) AS referenced_functions
    FROM pg_index index_row
    JOIN pg_class table_relation ON table_relation.oid = index_row.indrelid
    JOIN pg_class index_relation ON index_relation.oid = index_row.indexrelid
    JOIN pg_am access_method ON access_method.oid = index_relation.relam
    JOIN pg_namespace namespace ON namespace.oid = table_relation.relnamespace
    WHERE namespace.nspname = 'public'
    ORDER BY table_relation.relname, index_relation.relname
  `);
  for (const table of context.spec.tables) {
    compareExactSet(
      table.targetIndexSignatures,
      indexResult.rows
        .filter(({ table_name }) => table_name === table.name)
        .map(
          ({
            index_name,
            is_unique,
            access_method,
            expressions,
            predicate,
            is_valid,
            is_ready,
            referenced_functions,
          }) =>
            [
              index_name,
              is_unique ? 'unique' : 'non-unique',
              access_method,
              expressions
                .map((expression) =>
                  normalizePostgresExpression(expression, table.name),
                )
                .join(','),
              normalizePostgresExpression(predicate, table.name),
              is_valid ? 'valid' : 'invalid',
              is_ready ? 'ready' : 'not-ready',
              referenced_functions.join(','),
            ].join('|'),
        ),
      'TARGET_SCHEMA_MISMATCH',
      `${context.spec.logicalName}.target.${table.name}.indexes`,
    );
  }

  const functionNames = context.spec.targetFunctionSignatures.map(
    (signature) => signature.split('|', 1)[0],
  );
  const functionResult = await context.target.query<{
    function_name: string;
    function_kind: string;
    result_type: string;
    arguments: string;
    language_name: string;
    volatility: string;
    is_strict: boolean;
    is_security_definer: boolean;
    is_leakproof: boolean;
    returns_set: boolean;
    parallel_safety: string;
    configuration: string;
    source_body: string;
  }>(
    `
      SELECT
        procedure_row.proname AS function_name,
        procedure_row.prokind AS function_kind,
        pg_get_function_result(procedure_row.oid) AS result_type,
        pg_get_function_identity_arguments(procedure_row.oid) AS arguments,
        language_row.lanname AS language_name,
        procedure_row.provolatile AS volatility,
        procedure_row.proisstrict AS is_strict,
        procedure_row.prosecdef AS is_security_definer,
        procedure_row.proleakproof AS is_leakproof,
        procedure_row.proretset AS returns_set,
        procedure_row.proparallel AS parallel_safety,
        COALESCE(array_to_string(procedure_row.proconfig, E'\\n'), '') AS configuration,
        procedure_row.prosrc AS source_body
      FROM pg_proc procedure_row
      JOIN pg_namespace namespace
        ON namespace.oid = procedure_row.pronamespace
      JOIN pg_language language_row
        ON language_row.oid = procedure_row.prolang
      WHERE namespace.nspname = 'public'
        AND procedure_row.proname = ANY($1::text[])
      ORDER BY procedure_row.proname, arguments
    `,
    [functionNames],
  );
  compareExactSet(
    context.spec.targetFunctionSignatures,
    functionResult.rows.map((functionRow) =>
      [
        functionRow.function_name,
        functionRow.function_kind,
        functionRow.result_type,
        functionRow.arguments,
        functionRow.language_name,
        functionRow.volatility,
        functionRow.is_strict ? 'strict' : 'not-strict',
        functionRow.is_security_definer ? 'definer' : 'invoker',
        functionRow.is_leakproof ? 'leakproof' : 'not-leakproof',
        functionRow.returns_set ? 'set' : 'not-set',
        functionRow.parallel_safety === 's'
          ? 'safe'
          : functionRow.parallel_safety === 'r'
          ? 'restricted'
          : 'unsafe',
        functionRow.configuration,
        normalizePostgresRoutineDefinition(functionRow.source_body),
      ].join('|'),
    ),
    'TARGET_SCHEMA_MISMATCH',
    `${context.spec.logicalName}.target.functions`,
  );

  const triggerResult = await context.target.query<{
    table_name: string;
    trigger_name: string;
    trigger_type: number;
    enabled_kind: string;
    function_schema: string;
    function_name: string;
    arguments_hex: string;
    old_transition_table: string;
    new_transition_table: string;
    when_expression: string;
  }>(`
    SELECT
      relation.relname AS table_name,
      trigger_row.tgname AS trigger_name,
      trigger_row.tgtype::integer AS trigger_type,
      trigger_row.tgenabled AS enabled_kind,
      function_namespace.nspname AS function_schema,
      procedure_row.proname AS function_name,
      encode(trigger_row.tgargs, 'hex') AS arguments_hex,
      COALESCE(trigger_row.tgoldtable::text, '') AS old_transition_table,
      COALESCE(trigger_row.tgnewtable::text, '') AS new_transition_table,
      COALESCE(
        pg_get_expr(trigger_row.tgqual, trigger_row.tgrelid, true),
        ''
      ) AS when_expression
    FROM pg_trigger trigger_row
    JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    JOIN pg_proc procedure_row ON procedure_row.oid = trigger_row.tgfoid
    JOIN pg_namespace function_namespace
      ON function_namespace.oid = procedure_row.pronamespace
    WHERE namespace.nspname = 'public'
      AND NOT trigger_row.tgisinternal
    ORDER BY relation.relname, trigger_row.tgname
  `);
  for (const table of context.spec.tables) {
    compareExactSet(
      table.targetTriggerSignatures,
      triggerResult.rows
        .filter(({ table_name }) => table_name === table.name)
        .map((trigger) =>
          [
            trigger.trigger_name,
            String(trigger.trigger_type),
            trigger.enabled_kind,
            trigger.function_schema,
            trigger.function_name,
            trigger.arguments_hex,
            trigger.old_transition_table,
            trigger.new_transition_table,
            normalizePostgresRoutineDefinition(trigger.when_expression),
          ].join('|'),
        ),
      'TARGET_SCHEMA_MISMATCH',
      `${context.spec.logicalName}.target.${table.name}.triggers`,
    );
  }

  const foreignKeyTriggerResult = await context.target.query<{
    table_name: string;
    constraint_name: string;
    trigger_name: string;
    enabled_kind: string;
  }>(`
    SELECT
      source_relation.relname AS table_name,
      constraint_row.conname AS constraint_name,
      trigger_row.tgname AS trigger_name,
      trigger_row.tgenabled AS enabled_kind
    FROM pg_constraint constraint_row
    JOIN pg_class source_relation
      ON source_relation.oid = constraint_row.conrelid
    JOIN pg_namespace source_namespace
      ON source_namespace.oid = source_relation.relnamespace
    JOIN pg_trigger trigger_row
      ON trigger_row.tgconstraint = constraint_row.oid
     AND trigger_row.tgisinternal
    WHERE source_namespace.nspname = 'public'
      AND constraint_row.contype = 'f'
    ORDER BY source_relation.relname, constraint_row.conname, trigger_row.tgname
  `);
  for (const table of context.spec.tables) {
    const foreignKeyNames = table.targetConstraintSignatures
      .filter((signature) => signature.startsWith('f|'))
      .map((signature) => signature.split('|')[1]);
    for (const constraintName of foreignKeyNames) {
      const triggers = foreignKeyTriggerResult.rows.filter(
        (trigger) =>
          trigger.table_name === table.name &&
          trigger.constraint_name === constraintName,
      );
      if (
        triggers.length !== 4 ||
        triggers.some(({ enabled_kind }) => enabled_kind !== 'O')
      ) {
        const scope = `${context.spec.logicalName}.target.${table.name}.foreign_key_triggers`;
        throw new DataMigrationError(
          'TARGET_SCHEMA_MISMATCH',
          scope,
          `${scope} mismatch (expected four origin-enabled internal triggers for ${constraintName})`,
        );
      }
    }
  }
}

async function resetTarget(context: DatabaseContext): Promise<void> {
  await context.target.query(
    `TRUNCATE TABLE ${targetTableList(context, true)} RESTART IDENTITY`,
  );
}

function targetTableList(context: DatabaseContext, only = false): string {
  return context.spec.tables
    .map(({ name }) => `${only ? 'ONLY ' : ''}${quotePgIdentifier(name)}`)
    .join(', ');
}

function targetSequences(context: DatabaseContext): string[] {
  return context.spec.tables
    .flatMap((table) => table.targetSequenceSignatures)
    .map((signature) => {
      const [, schema, name] = signature.split('|');
      return `${quotePgIdentifier(schema)}.${quotePgIdentifier(name)}`;
    });
}

async function lockTargetTables(context: DatabaseContext): Promise<void> {
  await context.target.query(
    `LOCK TABLE ${targetTableList(context, true)} IN ACCESS EXCLUSIVE MODE`,
  );
  for (const sequence of targetSequences(context)) {
    // PostgreSQL rejects LOCK TABLE for sequences. ALTER ... RESTART takes a
    // transaction-held ShareRowExclusiveLock, and the restart itself rolls
    // back on preflight failure. A successful migration resets it anyway.
    await context.target.query(`ALTER SEQUENCE ${sequence} RESTART`);
  }
}

async function sourceCount(
  context: DatabaseContext,
  table: TableMigrationSpec,
): Promise<string> {
  const rows = await mysqlRows(
    context.source,
    `SELECT COUNT(*) AS row_count FROM ${quoteMysqlIdentifier(table.name)}`,
  );
  return exactCount(
    rows[0]?.row_count,
    `${context.spec.logicalName}.${table.name}.source_count`,
  );
}

async function targetCount(
  context: DatabaseContext,
  table: TableMigrationSpec,
): Promise<string> {
  const result = await context.target.query<{ row_count: string }>(
    `SELECT COUNT(*)::text AS row_count FROM ONLY ${quotePgIdentifier(
      table.name,
    )}`,
  );
  return exactCount(
    result.rows[0]?.row_count,
    `${context.spec.logicalName}.${table.name}.target_count`,
  );
}

function sourceKeysetExpression(
  key: SourceKeysetColumn,
  cursorValue: boolean,
): string {
  const valueExpression = cursorValue ? '?' : quoteMysqlIdentifier(key.column);
  if (!key.enumOrder) return valueExpression;
  const enumLiterals = key.enumOrder.map((value) => {
    if (!/^[a-z][a-z0-9_]*$/.test(value)) {
      throw new DataMigrationError(
        'MIGRATION_REGISTRY_INVALID',
        'registry.source_keyset.enum_order',
        'migration registry contains an unsafe source enum value',
      );
    }
    return `'${value}'`;
  });
  return `FIELD(${valueExpression}, ${enumLiterals.join(', ')})`;
}

async function sourceBatch(
  context: DatabaseContext,
  table: TableMigrationSpec,
  cursor: readonly unknown[] | undefined,
  batchSize: number,
): Promise<MigrationRow[]> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1_000) {
    throw new DataMigrationError(
      'MIGRATION_BATCH_SIZE_INVALID',
      'migration.batch_size',
      'migration batch size must be an integer between 1 and 1000',
    );
  }
  const columns = table.columns.map(quoteMysqlIdentifier).join(', ');
  const orderExpressions = table.sourceKeysetColumns.map((key) =>
    sourceKeysetExpression(key, false),
  );
  const cursorExpressions = table.sourceKeysetColumns.map((key) =>
    sourceKeysetExpression(key, true),
  );
  const orderBy = orderExpressions.join(', ');
  const parameters: unknown[] = [];
  let where = '';

  if (cursor) {
    if (table.sourceKeysetColumns.length === 1) {
      where = `WHERE ${orderExpressions[0]} > ${cursorExpressions[0]}`;
    } else {
      where = `WHERE (${orderExpressions.join(
        ', ',
      )}) > (${cursorExpressions.join(', ')})`;
    }
    parameters.push(...cursor);
  }
  return mysqlRows(
    context.source,
    `
      SELECT ${columns}
      FROM ${quoteMysqlIdentifier(table.name)}
      ${where}
      ORDER BY ${orderBy}
      LIMIT ${batchSize}
    `,
    parameters,
  );
}

async function insertBatch(
  context: DatabaseContext,
  table: TableMigrationSpec,
  rows: readonly MigrationRow[],
): Promise<void> {
  if (rows.length === 0) return;
  const parameters: unknown[] = [];
  const values = rows
    .map((row) => {
      const placeholders = table.insertColumns.map((column) => {
        parameters.push(row[column]);
        return `$${parameters.length}`;
      });
      return `(${placeholders.join(', ')})`;
    })
    .join(', ');
  const identityOverride =
    table.identityColumns.length > 0 ? ' OVERRIDING SYSTEM VALUE' : '';

  await context.target.query(
    `INSERT INTO ${quotePgIdentifier(table.name)} (${table.insertColumns
      .map(quotePgIdentifier)
      .join(', ')})${identityOverride} VALUES ${values}`,
    parameters,
  );
}

async function resetIdentitySequences(
  context: DatabaseContext,
  table: TableMigrationSpec,
): Promise<void> {
  for (const column of table.identityColumns) {
    const sourceIdentityRows = await mysqlRows(
      context.source,
      `
        SELECT
          table_info.AUTO_INCREMENT AS next_value,
          column_info.EXTRA AS extra
        FROM information_schema.tables table_info
        JOIN information_schema.columns column_info
          ON column_info.TABLE_SCHEMA = table_info.TABLE_SCHEMA
         AND column_info.TABLE_NAME = table_info.TABLE_NAME
        WHERE table_info.TABLE_SCHEMA = ?
          AND table_info.TABLE_NAME = ?
          AND column_info.COLUMN_NAME = ?
          AND table_info.TABLE_TYPE = 'BASE TABLE'
      `,
      [context.sourceDatabase, table.name, column],
    );
    const sourceIdentity = sourceIdentityRows[0];
    const nextValue = String(sourceIdentity?.next_value ?? '');
    if (
      sourceIdentityRows.length !== 1 ||
      !String(sourceIdentity?.extra ?? '')
        .toLowerCase()
        .includes('auto_increment') ||
      !/^[1-9]\d*$/.test(nextValue)
    ) {
      throw new DataMigrationError(
        'SOURCE_IDENTITY_METADATA_INVALID',
        `${context.spec.logicalName}.${table.name}.${column}`,
        `source AUTO_INCREMENT metadata is invalid for ${table.name}.${column}`,
      );
    }
    const sequenceResult = await context.target.query<{
      sequence_schema: string;
      sequence_name: string;
    }>(
      `
        SELECT
          sequence_namespace.nspname AS sequence_schema,
          sequence_relation.relname AS sequence_name
        FROM pg_class sequence_relation
        JOIN pg_namespace sequence_namespace
          ON sequence_namespace.oid = sequence_relation.relnamespace
        WHERE sequence_relation.oid = pg_get_serial_sequence($1, $2)::regclass
      `,
      [`public.${table.name}`, column],
    );
    const sequence = sequenceResult.rows[0];
    if (
      sequenceResult.rows.length !== 1 ||
      sequence?.sequence_schema !== 'public' ||
      !safeIdentifierPattern.test(sequence.sequence_name)
    ) {
      throw new DataMigrationError(
        'TARGET_IDENTITY_SEQUENCE_MISSING',
        `${context.spec.logicalName}.${table.name}.${column}`,
        `identity sequence is missing for ${table.name}.${column}`,
      );
    }

    const maximumResult = await context.target.query<{
      maximum: string | null;
    }>(
      `SELECT MAX(${quotePgIdentifier(
        column,
      )})::text AS maximum FROM ONLY ${quotePgIdentifier(table.name)}`,
    );
    const maximum = maximumResult.rows[0]?.maximum;
    if (
      maximum !== null &&
      maximum !== undefined &&
      BigInt(nextValue) <= BigInt(maximum)
    ) {
      throw new DataMigrationError(
        'SOURCE_IDENTITY_METADATA_INVALID',
        `${context.spec.logicalName}.${table.name}.${column}`,
        `source AUTO_INCREMENT does not exceed the migrated maximum for ${table.name}.${column}`,
      );
    }
    await context.target.query(
      `ALTER SEQUENCE ${quotePgIdentifier(
        sequence.sequence_schema,
      )}.${quotePgIdentifier(
        sequence.sequence_name,
      )} RESTART WITH ${nextValue}`,
    );
  }
}

async function targetSampleDigest(
  context: DatabaseContext,
  table: TableMigrationSpec,
  sampler: DeterministicSampler,
): Promise<string | null> {
  const samples = sampler.samples();
  if (samples.length === 0) return null;
  const selectedRows: MigrationRow[] = [];
  for (const sample of samples) {
    const where = table.primaryKeyColumns
      .map((column, index) => `${quotePgIdentifier(column)} = $${index + 1}`)
      .join(' AND ');
    const result = await context.target.query<MigrationRow>(
      `SELECT ${table.columns.map(quotePgIdentifier).join(', ')}
       FROM ONLY ${quotePgIdentifier(table.name)}
       WHERE ${where}`,
      [...sample.keyValues],
    );
    if (result.rows.length !== 1) {
      throw new DataMigrationError(
        'SAMPLE_ROW_MISSING',
        `${context.spec.logicalName}.${table.name}.sample`,
        `target sample row is missing for ${table.name}`,
      );
    }
    selectedRows.push(result.rows[0]);
  }

  return sha256(
    selectedRows.map((row) => table.columns.map((column) => row[column])),
  );
}

async function migrateTable(
  context: DatabaseContext,
  table: TableMigrationSpec,
  batchSize: number,
  sampleSize: number,
  logger: MigrationLogger,
): Promise<DataMigrationTableReport> {
  const startedAt = process.hrtime.bigint();
  const expectedRows = await sourceCount(context, table);
  const sampler = new DeterministicSampler(table.name, sampleSize);
  let cursor: readonly unknown[] | undefined;
  let migratedRows = 0n;

  logger.info('data_migration.table_started', {
    database: context.spec.logicalName,
    table: table.name,
    sourceRows: expectedRows,
  });

  while (true) {
    const batch = await sourceBatch(context, table, cursor, batchSize);
    if (batch.length === 0) break;
    const transformed = batch.map((row) => transformSourceRow(table, row));
    await insertBatch(context, table, transformed);
    for (const row of transformed) {
      sampler.add(
        table.primaryKeyColumns.map((column) => row[column]),
        row,
      );
    }
    migratedRows += BigInt(transformed.length);
    const lastRow = batch.at(-1)!;
    cursor = table.primaryKeyColumns.map((column) => lastRow[column]);
  }

  if (migratedRows.toString() !== expectedRows) {
    throw new DataMigrationError(
      'SOURCE_COUNT_CHANGED',
      `${context.spec.logicalName}.${table.name}.source_count`,
      `source snapshot count changed while migrating ${table.name}`,
    );
  }

  await resetIdentitySequences(context, table);
  const actualRows = await targetCount(context, table);
  if (actualRows !== expectedRows) {
    throw new DataMigrationError(
      'ROW_COUNT_MISMATCH',
      `${context.spec.logicalName}.${table.name}.row_count`,
      `row count mismatch for ${table.name}`,
    );
  }

  const sourceSampleDigest = sampler.digest(table.columns);
  const targetDigest = await targetSampleDigest(context, table, sampler);
  if (sourceSampleDigest !== targetDigest) {
    throw new DataMigrationError(
      'SAMPLE_DIGEST_MISMATCH',
      `${context.spec.logicalName}.${table.name}.sample`,
      `sample digest mismatch for ${table.name}`,
    );
  }

  const report: DataMigrationTableReport = {
    table: table.name,
    sourceRows: expectedRows,
    targetRows: actualRows,
    sampledRows: sampler.samples().length,
    sourceSampleDigest,
    targetSampleDigest: targetDigest,
    durationMs: monotonicElapsedMilliseconds(startedAt),
    status: 'passed',
  };
  logger.info('data_migration.table_finished', {
    database: context.spec.logicalName,
    table: table.name,
    rows: actualRows,
    sampledRows: report.sampledRows,
    durationMs: report.durationMs,
  });
  return report;
}

async function reconcileBusinessQueries(
  context: DatabaseContext,
): Promise<DataMigrationQueryReport[]> {
  const reports: DataMigrationQueryReport[] = [];
  for (const query of context.spec.businessQueries) {
    const sourceRows = await mysqlRows(context.source, query.sourceSql);
    const targetResult = await context.target.query<MigrationRow>(
      query.targetSql,
    );
    const sourceDigest = canonicalMultisetDigest(sourceRows);
    const targetDigest = canonicalMultisetDigest(targetResult.rows);
    if (sourceDigest !== targetDigest) {
      throw new DataMigrationError(
        'BUSINESS_QUERY_MISMATCH',
        `${context.spec.logicalName}.query.${query.name}`,
        `business query mismatch for ${query.name}`,
      );
    }
    reports.push({
      name: query.name,
      sourceRows: String(sourceRows.length),
      targetRows: String(targetResult.rows.length),
      sourceDigest,
      targetDigest,
      status: 'passed',
    });
  }
  return reports;
}

async function migrateDatabase(
  context: DatabaseContext,
  config: DataMigrationConfig,
  logger: MigrationLogger,
): Promise<DataMigrationDatabaseReport> {
  const startedAt = process.hrtime.bigint();
  const tables: DataMigrationTableReport[] = [];
  for (const table of context.spec.tables) {
    tables.push(
      await migrateTable(
        context,
        table,
        config.batchSize,
        config.sampleSize,
        logger,
      ),
    );
  }
  const businessQueries = await reconcileBusinessQueries(context);
  return {
    logicalName: context.spec.logicalName,
    tables,
    businessQueries,
    durationMs: monotonicElapsedMilliseconds(startedAt),
    status: 'passed',
  };
}

async function createContext(
  spec: DatabaseMigrationSpec,
  config: DataMigrationConfig,
): Promise<DatabaseContext> {
  const sourceDatabase =
    spec.logicalName === 'primary'
      ? config.mysql.primaryDatabase
      : config.mysql.competitorDatabase;
  const targetUrl =
    spec.logicalName === 'primary'
      ? config.postgres.primaryUrl
      : config.postgres.competitorUrl;
  const source = await mysql.createConnection({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: sourceDatabase,
    charset: 'utf8mb4',
    dateStrings: true,
    jsonStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
  });
  const targetPool = createPgPool(targetUrl, {
    max: 1,
    connectionTimeoutMillis: 15_000,
    idleTimeoutMillis: 1_000,
    types: migrationPgTypes,
  });
  try {
    const target = await targetPool.connect();
    return {
      spec,
      sourceDatabase,
      source,
      targetPool,
      target,
      sourceTransactionOpen: false,
      targetTransactionOpen: false,
      targetCommitAttempted: false,
      targetCommitted: false,
    };
  } catch (error) {
    await Promise.allSettled([targetPool.end(), source.end()]);
    throw error;
  }
}

async function beginTransactions(context: DatabaseContext): Promise<void> {
  await context.source.query("SET time_zone = '+08:00'");
  await context.source.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await context.source.query(
    'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY',
  );
  context.sourceTransactionOpen = true;
  await context.target.query("SET client_encoding TO 'UTF8'");
  await context.target.query('BEGIN');
  context.targetTransactionOpen = true;
  await context.target.query('SET LOCAL search_path TO public, pg_catalog');
  await context.target.query("SET LOCAL TIME ZONE 'Asia/Shanghai'");
  await context.target.query('SET LOCAL session_replication_role TO origin');
}

async function cleanupContext(
  context: DatabaseContext,
  logger: MigrationLogger,
): Promise<void> {
  if (context.targetTransactionOpen) {
    try {
      await context.target.query('ROLLBACK');
    } catch (error) {
      logger.error('data_migration.target_rollback_failed', {
        database: context.spec.logicalName,
        error,
      });
    }
  }
  if (context.sourceTransactionOpen) {
    try {
      await context.source.rollback();
    } catch (error) {
      logger.error('data_migration.source_rollback_failed', {
        database: context.spec.logicalName,
        error,
      });
    }
  }
  context.target.release();
  await Promise.allSettled([context.targetPool.end(), context.source.end()]);
}

export interface DataMigrationRunMetadata {
  readonly runId?: string;
  readonly startedAt?: Date;
}

function normalizeRunMetadata(metadata: DataMigrationRunMetadata): {
  readonly runId: string;
  readonly startedAt: Date;
} {
  const runIdResult = dataMigrationRunIdSchema.safeParse(
    metadata.runId ?? randomUUID(),
  );
  if (!runIdResult.success) {
    throw new DataMigrationError(
      'MIGRATION_METADATA_INVALID',
      'metadata.run_id',
      'migration run id must be a UUID',
    );
  }
  const startedAt = metadata.startedAt ?? new Date();
  if (!(startedAt instanceof Date) || !Number.isFinite(startedAt.getTime())) {
    throw new DataMigrationError(
      'MIGRATION_METADATA_INVALID',
      'metadata.started_at',
      'migration start time must be a valid Date',
    );
  }
  return {
    runId: runIdResult.data,
    startedAt: new Date(startedAt.getTime()),
  };
}

function monotonicElapsedMilliseconds(startedAt: bigint): number {
  return Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
}

export interface TargetCommitState {
  readonly logicalName: MigrationDatabaseName;
  readonly attempted: boolean;
  readonly committed: boolean;
}

export function targetCommitRiskError(
  states: readonly TargetCommitState[],
  cause: DataMigrationError,
): DataMigrationError | undefined {
  const indeterminate = states.filter(
    ({ attempted, committed }) => attempted && !committed,
  );
  if (indeterminate.length > 0) {
    return new DataMigrationError(
      'TARGET_COMMIT_INDETERMINATE',
      'target.commit',
      'a target COMMIT was attempted but its outcome was not confirmed; verify and reset both targets before rerunning',
      { cause },
    );
  }
  const committed = states.filter(({ committed }) => committed);
  if (committed.length > 0 && committed.length < states.length) {
    return new DataMigrationError(
      'TARGET_COMMIT_PARTIAL',
      'target.commit',
      'one target database committed before another target failed; reset and rerun both targets',
      { cause },
    );
  }
  if (committed.length === states.length && states.length > 0) {
    return new DataMigrationError(
      'POST_COMMIT_FINALIZATION_FAILED',
      'migration.post_commit',
      'both target databases committed but finalization failed; verify both targets before rerunning',
      { cause },
    );
  }
  return undefined;
}

export async function runDataMigration(
  config: DataMigrationConfig,
  logger: MigrationLogger = createMigrationLogger(),
  metadata: DataMigrationRunMetadata = {},
): Promise<DataMigrationReport> {
  config = validateDataMigrationConfig(config);
  if (!config.allowTargetReset) {
    throw new DataMigrationError(
      'TARGET_RESET_NOT_AUTHORIZED',
      'config.migration_allow_target_reset',
      'target reset requires MIGRATION_ALLOW_TARGET_RESET=true',
    );
  }

  const { runId, startedAt } = normalizeRunMetadata(metadata);
  const monotonicStartedAt = process.hrtime.bigint();
  const contexts: DatabaseContext[] = [];
  logger.info('data_migration.started', {
    runId,
    strategy: 'full-snapshot-cutover-sync',
    batchSize: config.batchSize,
    sampleSize: config.sampleSize,
  });

  try {
    for (const spec of databaseMigrationSpecs) {
      contexts.push(await createContext(spec, config));
    }
    for (const context of contexts) await beginTransactions(context);
    for (const context of contexts) await validateTargetEnvironment(context);
    for (const context of contexts) {
      await lockTargetTables(context);
      logger.info('data_migration.target_tables_locked', {
        database: context.spec.logicalName,
        tableCount: context.spec.tables.length,
      });
    }
    for (const context of contexts) {
      await validateSourceSchema(context);
      await validateTargetSchema(context);
    }
    for (const context of contexts) await resetTarget(context);

    const databases: DataMigrationDatabaseReport[] = [];
    for (const context of contexts) {
      databases.push(await migrateDatabase(context, config, logger));
    }

    for (const context of contexts) {
      context.targetCommitAttempted = true;
      await context.target.query('COMMIT');
      context.targetTransactionOpen = false;
      context.targetCommitted = true;
    }
    for (const context of contexts) {
      await context.source.rollback();
      context.sourceTransactionOpen = false;
    }

    const report = dataMigrationReportSchema.parse({
      schemaVersion: 1,
      runId,
      strategy: 'full-snapshot-cutover-sync',
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      batchSize: config.batchSize,
      sampleSize: config.sampleSize,
      targetResetAuthorized: true,
      databases,
      status: 'passed',
    });
    logger.info('data_migration.finished', {
      runId,
      status: report.status,
      durationMs: monotonicElapsedMilliseconds(monotonicStartedAt),
    });
    return report;
  } catch (error) {
    const migrationError = asDataMigrationError(error);
    const committed = contexts
      .filter(({ targetCommitted }) => targetCommitted)
      .map(({ spec }) => spec.logicalName);
    const indeterminate = contexts
      .filter(
        ({ targetCommitAttempted, targetCommitted }) =>
          targetCommitAttempted && !targetCommitted,
      )
      .map(({ spec }) => spec.logicalName);
    logger.error('data_migration.failed', {
      runId,
      code: migrationError.code,
      scope: migrationError.scope,
      committedDatabases: committed,
      indeterminateDatabases: indeterminate,
      error: migrationError,
    });
    const commitRisk = targetCommitRiskError(
      contexts.map((context) => ({
        logicalName: context.spec.logicalName,
        attempted: context.targetCommitAttempted,
        committed: context.targetCommitted,
      })),
      migrationError,
    );
    if (commitRisk) throw commitRisk;
    throw migrationError;
  } finally {
    await Promise.all(
      contexts.map((context) => cleanupContext(context, logger)),
    );
  }
}

export function databaseSpec(
  logicalName: MigrationDatabaseName,
): DatabaseMigrationSpec {
  return databaseMigrationSpecs.find(
    (spec) => spec.logicalName === logicalName,
  )!;
}
