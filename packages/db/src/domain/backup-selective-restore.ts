import {
  backupCanonicalTableNameSchema,
  backupQualifiedTableName,
  parseBackupTableIdentifiers,
} from '@asin-monitor/contracts';
import type { QueryConfig } from 'pg';
import { z } from 'zod';

const tablesSchema = z.array(backupCanonicalTableNameSchema).min(1).max(512);

export class BackupTableSelectionError extends Error {
  constructor(readonly reason: 'input' | 'unconfirmed') {
    super('BACKUP_TABLE_SELECTION_INVALID');
  }
}
/** Resolve all requested identities in one actual application/lock session.
 * Every part is quoted before to_regclass: mixed case must never fold, and
 * PGOPTIONS/URL options/role search_path stay entirely inside NodePG. */
export function backupTableSelectionQuery(
  tables: readonly string[],
): QueryConfig & { query_timeout: number } {
  const input = tablesSchema.parse(tables);
  const literal = (table: string) =>
    parseBackupTableIdentifiers(table)!
      .map((part) => `"${part.replaceAll('"', '""')}"`)
      .join('.');
  return {
    text: `/* backup_table_selection */ SELECT namespace.nspname AS schema, relation.relname AS name,
      relation.relkind AS kind, relation.relpersistence AS persistence
      FROM pg_catalog.unnest($1::pg_catalog.text[]) WITH ORDINALITY requested(name,position)
      LEFT JOIN pg_catalog.pg_class relation ON relation.oid=pg_catalog.to_regclass(requested.name)
      LEFT JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
      ORDER BY requested.position`,
    values: [input.map(literal)],
    query_timeout: 1500,
  };
}
export function resolveBackupTableSelection(
  tables: readonly string[],
  rows: unknown,
): string[] {
  const input = tablesSchema.parse(tables);
  const result = z
    .array(
      z
        .object({
          schema: z.string().nullable(),
          name: z.string().nullable(),
          kind: z.string().nullable(),
          persistence: z.string().nullable(),
        })
        .strict(),
    )
    .length(input.length)
    .safeParse(rows);
  if (!result.success) throw new BackupTableSelectionError('unconfirmed');
  return result.data.map((row, index) => {
    const requested = parseBackupTableIdentifiers(input[index])!;
    if (
      !row.schema ||
      !row.name ||
      !['r', 'p', 'v', 'm', 'f', 'S'].includes(row.kind || '') ||
      !['p', 'u'].includes(row.persistence || '') ||
      row.name !== requested.at(-1) ||
      (requested.length === 2 && row.schema !== requested[0])
    )
      throw new BackupTableSelectionError('input');
    try {
      return backupQualifiedTableName(row.schema, row.name);
    } catch {
      throw new BackupTableSelectionError('input');
    }
  });
}

/** Literal, case-sensitive names; ambiguous unqualified names fail closed.
 * pg_dump resolves unqualified patterns with source search-path visibility.
 * The older metadata does not freeze that path, so never count hidden names as
 * additional archived relations and incorrectly allow their dependencies.
 * Include all descendants for --table-and-children, not just direct children.
 * Follow automatic/internal ownership to sequences, row types and rules:
 * an outside default or function can block their implicit DROP too.
 * A missing target table is safe: restore will create it from the archive. */
export function backupSelectiveRestoreQuery(
  tables: readonly string[],
): QueryConfig & { query_timeout: number } {
  const input = tablesSchema.parse(tables);
  const parts = input.map((table) => parseBackupTableIdentifiers(table)!);
  const names = parts.map((table) => table.at(-1)!);
  const schemas = parts.map((table) => (table.length === 2 ? table[0]! : null));
  return {
    text: `/* backup_selective_restore_dependencies */
      WITH RECURSIVE requested AS (
        SELECT * FROM ROWS FROM (
          pg_catalog.unnest($1::pg_catalog.text[]), pg_catalog.unnest($2::pg_catalog.text[])
        ) AS requested(name, namespace)
      ), ambiguous AS (
        SELECT requested.name FROM requested JOIN pg_catalog.pg_class relation ON relation.relname = requested.name
        WHERE requested.namespace IS NULL AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        GROUP BY requested.name HAVING pg_catalog.count(DISTINCT relation.oid) > 1
      ), selected(oid) AS (
        SELECT relation.oid
        FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN requested ON relation.relname = requested.name
          AND (requested.namespace IS NULL OR namespace.nspname = requested.namespace)
        WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        UNION
        SELECT children.inhrelid FROM pg_catalog.pg_inherits children JOIN selected ON selected.oid = children.inhparent
      ), owned(classid, objid) AS (
        SELECT 'pg_catalog.pg_class'::pg_catalog.regclass::pg_catalog.oid, oid FROM selected
        UNION
        SELECT dependency.classid, dependency.objid FROM pg_catalog.pg_depend dependency JOIN owned
          ON dependency.refclassid = owned.classid AND dependency.refobjid = owned.objid
        WHERE dependency.deptype IN ('a', 'i')
      )
      SELECT EXISTS (
        SELECT 1 FROM pg_catalog.pg_depend dependency JOIN owned referenced
          ON dependency.refclassid = referenced.classid AND dependency.refobjid = referenced.objid
        WHERE dependency.deptype = 'n' AND NOT EXISTS (
          SELECT 1 FROM owned WHERE owned.classid = dependency.classid AND owned.objid = dependency.objid
        )
        UNION ALL
        SELECT 1 FROM pg_catalog.pg_depend membership JOIN owned
          ON membership.classid = owned.classid AND membership.objid = owned.objid
        WHERE membership.deptype = 'e'
        UNION ALL SELECT 1 FROM ambiguous
      ) AS blocked`,
    values: [names, schemas],
    query_timeout: 1500,
  };
}

export function selectiveBackupRestoreBlocked(rows: unknown): boolean {
  const result = z
    .array(z.object({ blocked: z.boolean() }).strict())
    .length(1)
    .safeParse(rows);
  if (!result.success)
    throw new Error('BACKUP_SELECTIVE_RESTORE_PROBE_UNCONFIRMED');
  return result.data[0]!.blocked;
}
