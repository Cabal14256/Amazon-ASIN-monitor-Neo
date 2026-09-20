import { sql } from 'drizzle-orm';
import type { Db } from '../client';
import { CompetitorWriteError } from '../domain/competitor-write';
import { competitorAsins, competitorVariantGroups } from '../schema-competitor';

/** Keep DDL from changing the installed timestamp/identity policy before commit.
 * Every update in the owning transaction must explicitly preserve/set its time. */
export async function prepareCompetitorWrites(
  db: Pick<Db, 'execute'>,
  ensureOpen: () => void,
) {
  ensureOpen();
  await db.execute(
    sql`LOCK TABLE ${competitorVariantGroups}, ${competitorAsins} IN ROW EXCLUSIVE MODE`,
  );
  ensureOpen();
  const result = await db.execute(sql`
    SELECT (
      SELECT count(*)::int FROM (VALUES
        (to_regclass('competitor_variant_groups'),'trg_competitor_variant_groups_update_time'),
        (to_regclass('competitor_asins'),'trg_competitor_asins_update_time')
      ) AS expected(table_oid,trigger_name)
      JOIN pg_catalog.pg_class c ON c.oid=expected.table_oid
      JOIN pg_catalog.pg_trigger t ON t.tgrelid=c.oid AND t.tgname=expected.trigger_name
      JOIN pg_catalog.pg_proc p ON p.oid=t.tgfoid
      WHERE t.tgenabled='O' AND NOT t.tgisinternal AND t.tgtype=19
        AND t.tgnargs=0 AND t.tgqual IS NULL AND t.tgattr=''::int2vector
        AND p.proname='set_competitor_update_timestamp' AND p.pronamespace=c.relnamespace
        AND pg_catalog.obj_description(p.oid,'pg_proc')='competitor-update-timestamp-policy-v1'
        AND current_setting('session_replication_role')='origin'
    ) AS triggers, EXISTS(
      SELECT 1 FROM pg_catalog.pg_index i
      WHERE i.indexrelid=to_regclass('idx_neo_competitor_write_asin_country')
        AND i.indrelid=to_regclass('competitor_asins')
        AND i.indisunique AND i.indisvalid AND i.indisready AND i.indnkeyatts=2
        AND i.indpred IS NULL
        AND i.indcollation[0]=to_regcollation('public.neo_competitor_query_ci')
        AND i.indcollation[1]=to_regcollation('public.neo_competitor_query_ci')
        AND pg_catalog.obj_description(i.indexrelid,'pg_class')='competitor-asin-country-policy-v1'
        AND EXISTS (
          SELECT 1 FROM pg_catalog.pg_collation c WHERE c.oid=i.indcollation[0]
            AND c.collprovider='i' AND NOT c.collisdeterministic AND c.colliculocale='und-u-ks-level1'
            AND c.collversion=pg_catalog.pg_collation_actual_version(c.oid)
        )
    ) AS identity
  `);
  ensureOpen();
  if (result.rows[0]?.triggers !== 2 || result.rows[0]?.identity !== true)
    throw new CompetitorWriteError('timestamp-policy');
  await db.execute(
    sql`SELECT set_config('asin_monitor.competitor_timestamp_mode','explicit',true)`,
  );
  ensureOpen();
}
