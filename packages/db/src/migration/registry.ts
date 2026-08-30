import { getTableColumns, getTableName, SQL } from 'drizzle-orm';
import { getTableConfig, PgDialect, type PgTable } from 'drizzle-orm/pg-core';

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
} from '../schema';
import {
  competitorAsins,
  competitorFeishuConfig,
  competitorMonitorHistory,
  competitorVariantGroups,
} from '../schema-competitor';

export type MigrationDatabaseName = 'primary' | 'competitor';

export interface SourceKeysetColumn {
  readonly column: string;
  readonly enumOrder?: readonly string[];
}

export interface TableMigrationSpec {
  readonly table: PgTable;
  readonly name: string;
  readonly columns: readonly string[];
  readonly insertColumns: readonly string[];
  readonly primaryKeyColumns: readonly string[];
  readonly sourceKeysetColumns: readonly SourceKeysetColumn[];
  readonly booleanColumns: ReadonlySet<string>;
  readonly jsonColumns: ReadonlySet<string>;
  readonly generatedColumns: ReadonlySet<string>;
  readonly identityColumns: readonly string[];
  readonly targetColumnSignatures: readonly string[];
  readonly targetConstraintSignatures: readonly string[];
  readonly targetIndexSignatures: readonly string[];
  readonly targetTriggerSignatures: readonly string[];
}

export interface BusinessQuerySpec {
  readonly name: string;
  readonly sourceSql: string;
  readonly targetSql: string;
}

export interface DatabaseMigrationSpec {
  readonly logicalName: MigrationDatabaseName;
  readonly tables: readonly TableMigrationSpec[];
  readonly businessQueries: readonly BusinessQuerySpec[];
  readonly targetFunctionSignatures: readonly string[];
}

const postgresDialect = new PgDialect();

function foldSqlOutsideStrings(value: string): string {
  let result = '';
  let inString = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character === "'") {
      result += character;
      if (inString && value[index + 1] === "'") {
        result += value[index + 1];
        index += 1;
      } else {
        inString = !inString;
      }
    } else {
      result += inString ? character : character.toLowerCase();
    }
  }
  return result;
}

function stripOuterParentheses(value: string): string {
  let normalized = value.trim();
  while (normalized.startsWith('(') && normalized.endsWith(')')) {
    let depth = 0;
    let inString = false;
    let enclosesWholeExpression = true;
    for (let index = 0; index < normalized.length; index += 1) {
      const character = normalized[index];
      if (character === "'") {
        if (inString && normalized[index + 1] === "'") {
          index += 1;
        } else {
          inString = !inString;
        }
      } else if (!inString && character === '(') {
        depth += 1;
      } else if (!inString && character === ')') {
        depth -= 1;
        if (depth === 0 && index < normalized.length - 1) {
          enclosesWholeExpression = false;
          break;
        }
      }
    }
    if (!enclosesWholeExpression || depth !== 0) break;
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

export function normalizePostgresExpression(value: string): string {
  let normalized = foldSqlOutsideStrings(value)
    .replaceAll('"', '')
    .replace(/::\s*(?:character varying|text)(?:\[\])?/g, '')
    .replace(/\b[a-z_][a-z0-9_]*\./g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s*,\s*/g, ',')
    .trim();
  normalized = stripOuterParentheses(normalized);
  let previous = '';
  while (previous !== normalized) {
    previous = normalized;
    normalized = normalized.replace(/\(\(([a-z_][a-z0-9_]*)\)\)/g, '($1)');
  }
  return normalized;
}

export function normalizePostgresCheckExpression(value: string): string {
  let normalized = normalizePostgresExpression(value);
  if (normalized.startsWith('check')) {
    normalized = stripOuterParentheses(normalized.slice(5).trim());
  }
  normalized = normalizePostgresExpression(normalized);
  const inExpression = /^\(?([a-z][a-z0-9_]*)\)?\s+in\s*\((.*)\)$/.exec(
    normalized,
  );
  if (inExpression) {
    return `${inExpression[1]}|in|${normalizePostgresExpression(
      inExpression[2],
    )}`;
  }
  const anyArrayExpression =
    /^\(?([a-z][a-z0-9_]*)\)?\s*=\s*any\s*\(\s*\(?\s*array\[(.*)\]\s*\)?\s*\)$/.exec(
      normalized,
    );
  if (anyArrayExpression) {
    return `${anyArrayExpression[1]}|in|${normalizePostgresExpression(
      anyArrayExpression[2],
    )}`;
  }
  return normalized;
}

function renderSql(value: SQL): string {
  const rendered = postgresDialect.sqlToQuery(value);
  if (rendered.params.length > 0) {
    throw new Error('migration schema fingerprints cannot contain parameters');
  }
  return rendered.sql;
}

function renderColumnExpression(value: unknown): string {
  if (value === undefined) return '';
  if (value instanceof SQL) return renderSql(value);
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
  if (
    typeof value === 'boolean' ||
    typeof value === 'number' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  throw new Error(
    'migration schema fingerprint contains an unsupported default',
  );
}

const aggregateTableNames = new Set([
  'monitor_history_agg',
  'monitor_history_agg_dim',
  'monitor_history_agg_variant_group',
]);
const aggregateGranularityOrder = Object.freeze(['hour', 'day', 'month']);

function sourceKeysetColumn(
  tableName: string,
  column: string,
): SourceKeysetColumn {
  return Object.freeze({
    column,
    ...(aggregateTableNames.has(tableName) && column === 'granularity'
      ? { enumOrder: aggregateGranularityOrder }
      : {}),
  });
}

function triggerArgumentHex(value: string): string {
  return Buffer.from(`${value}\0`, 'utf8').toString('hex');
}

const updatedTimestampFunctionBody = normalizePostgresExpression(`
  BEGIN
    CASE TG_ARGV[0]
      WHEN 'update_time' THEN NEW.update_time := LOCALTIMESTAMP;
      WHEN 'updated_at' THEN NEW.updated_at := LOCALTIMESTAMP;
      ELSE
        RAISE EXCEPTION 'unsupported timestamp column: %', TG_ARGV[0]
          USING ERRCODE = '22023';
    END CASE;
    RETURN NEW;
  END;
`);

const updatedTimestampFunctionSignature = [
  'set_updated_timestamp_column',
  'f',
  'trigger',
  '',
  'plpgsql',
  'v',
  'not-strict',
  'invoker',
  'not-leakproof',
  'not-set',
  'unsafe',
  '',
  updatedTimestampFunctionBody,
].join('|');

function indexSignature(
  name: string,
  unique: boolean,
  method: string,
  expressions: readonly string[],
  predicate = '',
): string {
  return [
    name,
    unique ? 'unique' : 'non-unique',
    method,
    expressions.join(','),
    predicate,
    'valid',
    'ready',
  ].join('|');
}

function postgresCatalogType(sqlType: string): string {
  if (sqlType === 'timestamp') return 'timestamp without time zone';
  if (sqlType.startsWith('varchar(')) {
    return sqlType.replace(/^varchar/, 'character varying');
  }
  if (sqlType.startsWith('char(')) {
    return sqlType.replace(/^char/, 'character');
  }
  return sqlType;
}

function requiredConstraintName(
  value: string | undefined,
  tableName: string,
): string {
  if (!value) {
    throw new Error(`migration table ${tableName} has an unnamed constraint`);
  }
  return value;
}

function tableSpec(table: PgTable): TableMigrationSpec {
  const tableName = getTableName(table);
  const columns = Object.values(getTableColumns(table));
  const tableConfig = getTableConfig(table);
  const inlinePrimaryKeys = columns
    .filter((column) => column.primary)
    .map((column) => column.name);
  const compositePrimaryKeys = tableConfig.primaryKeys.flatMap((primaryKey) =>
    primaryKey.columns.map((column) => column.name),
  );
  const primaryKeyColumns =
    compositePrimaryKeys.length > 0 ? compositePrimaryKeys : inlinePrimaryKeys;

  if (primaryKeyColumns.length === 0) {
    throw new Error(`migration table ${tableName} has no primary key`);
  }

  const generatedColumns = new Set(
    columns
      .filter((column) => Boolean(column.generated))
      .map((column) => column.name),
  );
  const targetColumnSignatures = columns.map((column) => {
    const identityKind = column.generatedIdentity
      ? column.generatedIdentity.type === 'always'
        ? 'a'
        : 'd'
      : '';
    const generatedExpression = column.generated
      ? typeof column.generated.as === 'function'
        ? column.generated.as()
        : column.generated.as
      : undefined;
    const storedExpression = normalizePostgresExpression(
      renderColumnExpression(generatedExpression ?? column.default),
    );
    return [
      column.name,
      postgresCatalogType(column.getSQLType()),
      column.notNull ? 'not-null' : 'nullable',
      identityKind,
      column.generated ? 's' : '',
      storedExpression,
    ].join('|');
  });
  const targetConstraintSignatures: string[] = [];
  const constraintIndexSignatures: string[] = [];
  const addKeyConstraint = (
    type: 'p' | 'u',
    name: string,
    constraintColumns: readonly string[],
  ) => {
    targetConstraintSignatures.push(
      [type, name, constraintColumns.join(',')].join('|'),
    );
    constraintIndexSignatures.push(
      indexSignature(name, true, 'btree', constraintColumns),
    );
  };
  if (inlinePrimaryKeys.length > 0) {
    addKeyConstraint('p', `${tableName}_pkey`, inlinePrimaryKeys);
  }
  for (const primaryKey of tableConfig.primaryKeys) {
    addKeyConstraint(
      'p',
      primaryKey.getName(),
      primaryKey.columns.map((column) => column.name),
    );
  }
  for (const column of columns.filter(({ isUnique }) => isUnique)) {
    addKeyConstraint(
      'u',
      requiredConstraintName(column.uniqueName, tableName),
      [column.name],
    );
  }
  for (const uniqueConstraint of tableConfig.uniqueConstraints) {
    addKeyConstraint(
      'u',
      requiredConstraintName(uniqueConstraint.getName(), tableName),
      uniqueConstraint.columns.map((column) => column.name),
    );
  }
  for (const foreignKey of tableConfig.foreignKeys) {
    const reference = foreignKey.reference();
    targetConstraintSignatures.push(
      [
        'f',
        reference.name,
        reference.columns.map((column) => column.name).join(','),
        getTableName(reference.foreignTable),
        reference.foreignColumns.map((column) => column.name).join(','),
        foreignKey.onUpdate ?? 'no action',
        foreignKey.onDelete ?? 'no action',
      ].join('|'),
    );
  }
  for (const checkConstraint of tableConfig.checks) {
    targetConstraintSignatures.push(
      `c|${checkConstraint.name}|${normalizePostgresCheckExpression(
        renderSql(checkConstraint.value),
      )}`,
    );
  }
  const targetIndexSignatures = [
    ...tableConfig.indexes.map((index) => {
      const expressions = index.config.columns.map((column) => {
        if ('name' in column && typeof column.name === 'string') {
          const indexConfig = column.indexConfig ?? {
            order: 'asc',
            nulls: 'last',
            opClass: undefined,
          };
          const order = indexConfig.order === 'desc' ? ' desc' : '';
          const defaultNulls = indexConfig.order === 'desc' ? 'first' : 'last';
          const nulls =
            indexConfig.nulls !== defaultNulls
              ? ` nulls ${indexConfig.nulls}`
              : '';
          const opClass = indexConfig.opClass ? ` ${indexConfig.opClass}` : '';
          return normalizePostgresExpression(
            `${column.name}${opClass}${order}${nulls}`,
          );
        }
        return normalizePostgresExpression(renderSql(column as SQL));
      });
      const predicate = index.config.where
        ? normalizePostgresExpression(renderSql(index.config.where))
        : '';
      return indexSignature(
        requiredConstraintName(index.config.name, tableName),
        index.config.unique,
        index.config.method ?? 'btree',
        expressions,
        predicate,
      );
    }),
    ...constraintIndexSignatures,
  ];
  const updatedTimestampColumns = columns.filter(({ name }) =>
    ['update_time', 'updated_at'].includes(name),
  );
  if (updatedTimestampColumns.length > 1) {
    throw new Error(
      `migration table ${tableName} has multiple updated timestamp columns`,
    );
  }
  const targetTriggerSignatures = updatedTimestampColumns.map(({ name }) =>
    [
      `trg_${tableName}_${name}`,
      '19',
      'O',
      'public',
      'set_updated_timestamp_column',
      triggerArgumentHex(name),
      '',
      '',
      '',
    ].join('|'),
  );

  return Object.freeze({
    table,
    name: tableName,
    columns: Object.freeze(columns.map((column) => column.name)),
    insertColumns: Object.freeze(
      columns
        .map((column) => column.name)
        .filter((column) => !generatedColumns.has(column)),
    ),
    primaryKeyColumns: Object.freeze(primaryKeyColumns),
    sourceKeysetColumns: Object.freeze(
      primaryKeyColumns.map((column) => sourceKeysetColumn(tableName, column)),
    ),
    booleanColumns: new Set(
      columns
        .filter((column) => column.getSQLType() === 'boolean')
        .map((column) => column.name),
    ),
    jsonColumns: new Set(
      columns
        .filter((column) => column.getSQLType() === 'jsonb')
        .map((column) => column.name),
    ),
    generatedColumns,
    identityColumns: Object.freeze(
      columns
        .filter((column) => Boolean(column.generatedIdentity))
        .map((column) => column.name),
    ),
    targetColumnSignatures: Object.freeze(targetColumnSignatures.sort()),
    targetConstraintSignatures: Object.freeze(
      targetConstraintSignatures.sort(),
    ),
    targetIndexSignatures: Object.freeze(targetIndexSignatures.sort()),
    targetTriggerSignatures: Object.freeze(targetTriggerSignatures.sort()),
  });
}

// Parent tables precede children so FK checks remain enabled during import.
const primaryTables = [
  variantGroups,
  users,
  roles,
  permissions,
  feishuConfig,
  spApiConfig,
  backupConfig,
  asins,
  monitorHistory,
  monitorHistoryAgg,
  monitorHistoryAggDim,
  monitorHistoryAggVariantGroup,
  analyticsRefreshWatermark,
  monitorHistoryStatusInterval,
  passwordHistory,
  loginAttempts,
  userStatusHistory,
  sessions,
  userRoles,
  rolePermissions,
  auditLogs,
].map(tableSpec);

const competitorTables = [
  competitorVariantGroups,
  competitorAsins,
  competitorMonitorHistory,
  competitorFeishuConfig,
].map(tableSpec);

const primaryBusinessQueries: readonly BusinessQuerySpec[] = [
  {
    name: 'asin_health_by_country',
    sourceSql: `
      SELECT
        country,
        CAST(COUNT(*) AS CHAR) AS total_count,
        CAST(COALESCE(SUM(CASE WHEN is_broken = 1 THEN 1 ELSE 0 END), 0) AS CHAR) AS broken_count,
        CAST(COALESCE(SUM(CASE WHEN manual_excluded_from_group = 1 THEN 1 ELSE 0 END), 0) AS CHAR) AS excluded_count
      FROM asins
      GROUP BY country
      ORDER BY country
    `,
    targetSql: `
      SELECT
        country,
        COUNT(*)::text AS total_count,
        COALESCE(SUM(CASE WHEN is_broken THEN 1 ELSE 0 END), 0)::text AS broken_count,
        COALESCE(SUM(CASE WHEN manual_excluded_from_group THEN 1 ELSE 0 END), 0)::text AS excluded_count
      FROM asins
      GROUP BY country
      ORDER BY country
    `,
  },
  {
    name: 'variant_health_by_country',
    sourceSql: `
      SELECT
        country,
        CAST(COUNT(*) AS CHAR) AS total_count,
        CAST(COALESCE(SUM(CASE WHEN is_broken = 1 THEN 1 ELSE 0 END), 0) AS CHAR) AS broken_count,
        CAST(COALESCE(SUM(CASE WHEN manual_broken = 1 THEN 1 ELSE 0 END), 0) AS CHAR) AS manual_count
      FROM variant_groups
      GROUP BY country
      ORDER BY country
    `,
    targetSql: `
      SELECT
        country,
        COUNT(*)::text AS total_count,
        COALESCE(SUM(CASE WHEN is_broken THEN 1 ELSE 0 END), 0)::text AS broken_count,
        COALESCE(SUM(CASE WHEN manual_broken THEN 1 ELSE 0 END), 0)::text AS manual_count
      FROM variant_groups
      GROUP BY country
      ORDER BY country
    `,
  },
  {
    name: 'history_by_country_and_type',
    sourceSql: `
      SELECT
        country,
        COALESCE(check_type, '') AS check_type,
        CAST(COUNT(*) AS CHAR) AS total_count,
        CAST(COALESCE(SUM(CASE WHEN is_broken = 1 THEN 1 ELSE 0 END), 0) AS CHAR) AS broken_count,
        CAST(COALESCE(SUM(CASE WHEN notification_sent = 1 THEN 1 ELSE 0 END), 0) AS CHAR) AS notified_count
      FROM monitor_history
      GROUP BY country, COALESCE(check_type, '')
      ORDER BY country, COALESCE(check_type, '')
    `,
    targetSql: `
      SELECT
        country,
        COALESCE(check_type, '') AS check_type,
        COUNT(*)::text AS total_count,
        COALESCE(SUM(CASE WHEN is_broken THEN 1 ELSE 0 END), 0)::text AS broken_count,
        COALESCE(SUM(CASE WHEN notification_sent THEN 1 ELSE 0 END), 0)::text AS notified_count
      FROM monitor_history
      GROUP BY country, COALESCE(check_type, '')
      ORDER BY country, COALESCE(check_type, '')
    `,
  },
  {
    name: 'rbac_permissions_by_role',
    sourceSql: `
      SELECT
        roles.code,
        CAST(COUNT(role_permissions.permission_id) AS CHAR) AS permission_count
      FROM roles
      LEFT JOIN role_permissions ON role_permissions.role_id = roles.id
      GROUP BY roles.code
      ORDER BY roles.code
    `,
    targetSql: `
      SELECT
        roles.code,
        COUNT(role_permissions.permission_id)::text AS permission_count
      FROM roles
      LEFT JOIN role_permissions ON role_permissions.role_id = roles.id
      GROUP BY roles.code
      ORDER BY roles.code
    `,
  },
  {
    name: 'analytics_rows_by_granularity',
    sourceSql: `
      SELECT aggregate_name, granularity, country, row_count
      FROM (
        SELECT 'asin' AS aggregate_name, granularity, country, CAST(COUNT(*) AS CHAR) AS row_count
        FROM monitor_history_agg
        GROUP BY granularity, country
        UNION ALL
        SELECT 'dimension' AS aggregate_name, granularity, country, CAST(COUNT(*) AS CHAR) AS row_count
        FROM monitor_history_agg_dim
        GROUP BY granularity, country
        UNION ALL
        SELECT 'variant_group' AS aggregate_name, granularity, country, CAST(COUNT(*) AS CHAR) AS row_count
        FROM monitor_history_agg_variant_group
        GROUP BY granularity, country
      ) aggregate_rows
      ORDER BY aggregate_name, FIELD(granularity, 'hour', 'day', 'month'), country
    `,
    targetSql: `
      SELECT aggregate_name, granularity, country, row_count
      FROM (
        SELECT 'asin' AS aggregate_name, granularity, country, COUNT(*)::text AS row_count
        FROM monitor_history_agg
        GROUP BY granularity, country
        UNION ALL
        SELECT 'dimension' AS aggregate_name, granularity, country, COUNT(*)::text AS row_count
        FROM monitor_history_agg_dim
        GROUP BY granularity, country
        UNION ALL
        SELECT 'variant_group' AS aggregate_name, granularity, country, COUNT(*)::text AS row_count
        FROM monitor_history_agg_variant_group
        GROUP BY granularity, country
      ) aggregate_rows
      ORDER BY aggregate_name,
        CASE granularity WHEN 'hour' THEN 1 WHEN 'day' THEN 2 WHEN 'month' THEN 3 END,
        country
    `,
  },
];

const competitorBusinessQueries: readonly BusinessQuerySpec[] = [
  {
    name: 'competitor_asin_health_by_country',
    sourceSql: `
      SELECT
        country,
        CAST(COUNT(*) AS CHAR) AS total_count,
        CAST(COALESCE(SUM(CASE WHEN is_broken = 1 THEN 1 ELSE 0 END), 0) AS CHAR) AS broken_count
      FROM competitor_asins
      GROUP BY country
      ORDER BY country
    `,
    targetSql: `
      SELECT
        country,
        COUNT(*)::text AS total_count,
        COALESCE(SUM(CASE WHEN is_broken THEN 1 ELSE 0 END), 0)::text AS broken_count
      FROM competitor_asins
      GROUP BY country
      ORDER BY country
    `,
  },
  {
    name: 'competitor_history_by_country_and_type',
    sourceSql: `
      SELECT
        country,
        COALESCE(check_type, '') AS check_type,
        CAST(COUNT(*) AS CHAR) AS total_count,
        CAST(COALESCE(SUM(CASE WHEN is_broken = 1 THEN 1 ELSE 0 END), 0) AS CHAR) AS broken_count
      FROM competitor_monitor_history
      GROUP BY country, COALESCE(check_type, '')
      ORDER BY country, COALESCE(check_type, '')
    `,
    targetSql: `
      SELECT
        country,
        COALESCE(check_type, '') AS check_type,
        COUNT(*)::text AS total_count,
        COALESCE(SUM(CASE WHEN is_broken THEN 1 ELSE 0 END), 0)::text AS broken_count
      FROM competitor_monitor_history
      GROUP BY country, COALESCE(check_type, '')
      ORDER BY country, COALESCE(check_type, '')
    `,
  },
];

export const databaseMigrationSpecs: readonly DatabaseMigrationSpec[] = [
  Object.freeze({
    logicalName: 'primary',
    tables: Object.freeze(primaryTables),
    businessQueries: Object.freeze(primaryBusinessQueries),
    targetFunctionSignatures: Object.freeze([
      updatedTimestampFunctionSignature,
    ]),
  }),
  Object.freeze({
    logicalName: 'competitor',
    tables: Object.freeze(competitorTables),
    businessQueries: Object.freeze(competitorBusinessQueries),
    targetFunctionSignatures: Object.freeze([
      updatedTimestampFunctionSignature,
    ]),
  }),
];
