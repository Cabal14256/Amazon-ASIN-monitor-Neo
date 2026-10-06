import type { QueryConfig } from 'pg';
import { z } from 'zod';

const tablesSchema = z
  .array(
    z
      .string()
      .max(130)
      .regex(/^[a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_]*)?$/),
  )
  .min(1)
  .max(512);

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
  const names = input.map((table) => table.split('.').at(-1)!);
  const schemas = input.map((table) =>
    table.includes('.') ? table.split('.')[0]! : null,
  );
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
