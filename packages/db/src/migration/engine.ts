import { randomUUID } from 'node:crypto';

import {
  dataMigrationReportSchema,
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
  DeterministicSampler,
  parseMigrationJsonDocument,
  sha256,
  transformSourceRow,
  type MigrationRow,
} from './canonical';
import type { DataMigrationConfig } from './config';
import { DataMigrationError, asDataMigrationError } from './errors';
import { createMigrationLogger, type MigrationLogger } from './logger';
import {
  databaseMigrationSpecs,
  type DatabaseMigrationSpec,
  type MigrationDatabaseName,
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

  const missing = expectedSorted.filter(
    (value) => !actualSorted.includes(value),
  );
  const extra = actualSorted.filter((value) => !expectedSorted.includes(value));
  throw new DataMigrationError(
    code,
    scope,
    `${scope} mismatch (missing: ${missing.join(',') || 'none'}; extra: ${
      extra.join(',') || 'none'
    })`,
  );
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
        COLUMN_NAME AS column_name
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
  }
}

async function validateTargetSchema(context: DatabaseContext): Promise<void> {
  const tableResult = await context.target.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  compareExactSet(
    context.spec.tables.map(({ name }) => name),
    tableResult.rows.map(({ table_name }) => table_name),
    'TARGET_SCHEMA_MISMATCH',
    `${context.spec.logicalName}.target.tables`,
  );

  const columnResult = await context.target.query<{
    table_name: string;
    column_name: string;
  }>(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position
  `);
  for (const table of context.spec.tables) {
    compareExactSet(
      table.columns,
      columnResult.rows
        .filter(({ table_name }) => table_name === table.name)
        .map(({ column_name }) => column_name),
      'TARGET_SCHEMA_MISMATCH',
      `${context.spec.logicalName}.target.${table.name}`,
    );
  }
}

async function resetTarget(context: DatabaseContext): Promise<void> {
  const tables = context.spec.tables
    .map(({ name }) => quotePgIdentifier(name))
    .join(', ');
  await context.target.query(
    `TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`,
  );
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
    `SELECT COUNT(*)::text AS row_count FROM ${quotePgIdentifier(table.name)}`,
  );
  return exactCount(
    result.rows[0]?.row_count,
    `${context.spec.logicalName}.${table.name}.target_count`,
  );
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
  const orderBy = table.primaryKeyColumns.map(quoteMysqlIdentifier).join(', ');
  const parameters: unknown[] = [];
  let where = '';

  if (cursor) {
    if (table.primaryKeyColumns.length === 1) {
      where = `WHERE ${quoteMysqlIdentifier(table.primaryKeyColumns[0])} > ?`;
    } else {
      where = `WHERE (${table.primaryKeyColumns
        .map(quoteMysqlIdentifier)
        .join(', ')}) > (${table.primaryKeyColumns.map(() => '?').join(', ')})`;
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
    const sequenceResult = await context.target.query<{
      sequence_name: string | null;
    }>('SELECT pg_get_serial_sequence($1, $2) AS sequence_name', [
      table.name,
      column,
    ]);
    const sequenceName = sequenceResult.rows[0]?.sequence_name;
    if (!sequenceName) {
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
      )})::text AS maximum FROM ${quotePgIdentifier(table.name)}`,
    );
    const maximum = maximumResult.rows[0]?.maximum;
    if (maximum === null || maximum === undefined) {
      await context.target.query('SELECT setval($1::regclass, 1, false)', [
        sequenceName,
      ]);
    } else {
      await context.target.query(
        'SELECT setval($1::regclass, $2::bigint, true)',
        [sequenceName, maximum],
      );
    }
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
       FROM ${quotePgIdentifier(table.name)}
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
  const startedAt = Date.now();
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
    durationMs: Date.now() - startedAt,
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
    const sourceDigest = sha256(sourceRows);
    const targetDigest = sha256(targetResult.rows);
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
  const startedAt = Date.now();
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
    durationMs: Date.now() - startedAt,
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
  await context.target.query('BEGIN');
  context.targetTransactionOpen = true;
  await context.target.query("SET LOCAL TIME ZONE 'Asia/Shanghai'");
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

export async function runDataMigration(
  config: DataMigrationConfig,
  logger: MigrationLogger = createMigrationLogger(),
  metadata: DataMigrationRunMetadata = {},
): Promise<DataMigrationReport> {
  if (!config.allowTargetReset) {
    throw new DataMigrationError(
      'TARGET_RESET_NOT_AUTHORIZED',
      'config.migration_allow_target_reset',
      'target reset requires MIGRATION_ALLOW_TARGET_RESET=true',
    );
  }

  const runId = metadata.runId ?? randomUUID();
  const startedAt = metadata.startedAt ?? new Date();
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
      durationMs: new Date(report.finishedAt).getTime() - startedAt.getTime(),
    });
    return report;
  } catch (error) {
    const migrationError = asDataMigrationError(error);
    const committed = contexts
      .filter(({ targetCommitted }) => targetCommitted)
      .map(({ spec }) => spec.logicalName);
    logger.error('data_migration.failed', {
      runId,
      code: migrationError.code,
      scope: migrationError.scope,
      committedDatabases: committed,
      error: migrationError,
    });
    if (committed.length > 0 && committed.length < contexts.length) {
      throw new DataMigrationError(
        'TARGET_COMMIT_PARTIAL',
        'target.commit',
        'one target database committed before another target failed; reset and rerun both targets',
        { cause: migrationError },
      );
    }
    if (committed.length === contexts.length && contexts.length > 0) {
      throw new DataMigrationError(
        'POST_COMMIT_FINALIZATION_FAILED',
        'migration.post_commit',
        'both target databases committed but finalization failed; verify both targets before rerunning',
        { cause: migrationError },
      );
    }
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
