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
        SELECT * FROM unnest($1::text[], $2::text[]) AS requested(name, namespace)
      ), ambiguous AS (
        SELECT requested.name FROM requested JOIN pg_class relation ON relation.relname = requested.name
        WHERE requested.namespace IS NULL AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        GROUP BY requested.name HAVING count(DISTINCT relation.oid) > 1
      ), selected(oid) AS (
        SELECT relation.oid
        FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
        JOIN requested ON relation.relname = requested.name
          AND (requested.namespace IS NULL OR namespace.nspname = requested.namespace)
        WHERE relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
        UNION
        SELECT children.inhrelid FROM pg_inherits children JOIN selected ON selected.oid = children.inhparent
      )
      SELECT EXISTS (
        SELECT 1 FROM pg_depend dependency
        WHERE dependency.refclassid = 'pg_class'::regclass
          AND dependency.refobjid IN (SELECT oid FROM selected)
          AND dependency.deptype = 'n'
          AND CASE dependency.classid
            WHEN 'pg_constraint'::regclass THEN NOT EXISTS (
              SELECT 1 FROM pg_constraint owned WHERE owned.oid = dependency.objid AND owned.conrelid IN (SELECT oid FROM selected)
            )
            WHEN 'pg_rewrite'::regclass THEN NOT EXISTS (
              SELECT 1 FROM pg_rewrite owned WHERE owned.oid = dependency.objid AND owned.ev_class IN (SELECT oid FROM selected)
            )
            WHEN 'pg_attrdef'::regclass THEN NOT EXISTS (
              SELECT 1 FROM pg_attrdef owned WHERE owned.oid = dependency.objid AND owned.adrelid IN (SELECT oid FROM selected)
            )
            WHEN 'pg_class'::regclass THEN NOT EXISTS (
              SELECT 1 FROM selected WHERE selected.oid = dependency.objid
              UNION ALL SELECT 1 FROM pg_index owned WHERE owned.indexrelid = dependency.objid AND owned.indrelid IN (SELECT oid FROM selected)
            )
            ELSE true
          END
        UNION ALL
        SELECT 1 FROM pg_depend membership WHERE membership.classid = 'pg_class'::regclass
          AND membership.objid IN (SELECT oid FROM selected) AND membership.deptype = 'e'
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
