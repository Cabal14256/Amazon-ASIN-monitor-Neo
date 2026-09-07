import { sql } from 'drizzle-orm';
import type { Db } from '../client';
import { asins, variantGroups } from '../schema';

export class AsinTimestampPolicyError extends Error {
  constructor() {
    super('ASIN timestamp policy upgrade is required');
    this.name = 'AsinTimestampPolicyError';
  }
}

/** Call inside an owned transaction, before any business writes. Compatible
 * table locks prevent trigger DDL/rollback between the probe and commit.
 * The caller owns update_time for EVERY ASIN/group update in this transaction.
 */
export async function prepareAsinTimestampWrites(
  db: Pick<Db, 'execute'>,
  ensureOpen: () => void,
): Promise<void> {
  ensureOpen();
  await db.execute(
    sql`LOCK TABLE ${variantGroups}, ${asins} IN ROW EXCLUSIVE MODE`,
  );
  ensureOpen();
  const result = await db.execute(sql`
    SELECT count(*)::int AS installed
    FROM (VALUES
      (to_regclass('variant_groups'), 'trg_variant_groups_update_time'),
      (to_regclass('asins'), 'trg_asins_update_time')
    ) AS expected(table_oid, trigger_name)
    JOIN pg_catalog.pg_class c ON c.oid=expected.table_oid
    JOIN pg_catalog.pg_trigger t ON t.tgrelid=c.oid AND t.tgname=expected.trigger_name
    JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
    WHERE t.tgenabled='O' AND NOT t.tgisinternal AND t.tgtype=19
      AND t.tgnargs=0 AND t.tgqual IS NULL AND t.tgattr=''::int2vector
      AND p.proname='set_asin_update_timestamp' AND p.pronamespace=c.relnamespace
      AND pg_catalog.obj_description(p.oid, 'pg_proc')='asin-update-timestamp-policy-v1'
      AND current_setting('session_replication_role')='origin'
  `);
  ensureOpen();
  if (result.rows[0]?.installed !== 2) throw new AsinTimestampPolicyError();
  await db.execute(
    sql`SELECT set_config('asin_monitor.timestamp_mode', 'explicit', true)`,
  );
  ensureOpen();
}
