import { sql } from 'drizzle-orm';
import type { Db } from '../client';

/** Reconcile one receipt on an exclusively held READ COMMITTED transaction.
 * The caller owns its deadline/rollback. History writers acquire this same row
 * through the trigger, so no committed mutation can lose its pending receipt.
 * No aggregate watermark or maximum history timestamp proves this invariant.
 */
export async function reconcileMonitorInterval(
  db: Db,
  ensureOpen: () => void,
): Promise<boolean> {
  ensureOpen();
  const claimed = await db.execute(sql`
    SELECT asin_key, country FROM public.monitor_interval_dirty
    WHERE completed_revision <> revision
    ORDER BY queued_at, asin_key, country LIMIT 1 FOR UPDATE SKIP LOCKED
  `);
  ensureOpen();
  // Retention drops whole Timescale chunks without row DELETE triggers. Keep
  // each completed key's source relations, so a missing chunk also queues work.
  // First use the partial pending index; inspect old receipts only when empty.
  const key =
    claimed.rows[0] ??
    (
      await db.execute(sql`
    SELECT asin_key, country FROM public.monitor_interval_dirty d
    WHERE EXISTS (
      SELECT 1 FROM unnest(d.source_relation_ids) relation_id
      WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid = relation_id::oid)
    ) ORDER BY queued_at, asin_key, country LIMIT 1 FOR UPDATE SKIP LOCKED
  `)
    ).rows[0];
  ensureOpen();
  if (!key) return false;
  const asinKey = String(key.asin_key),
    country = String(key.country);
  await db.execute(sql`DELETE FROM public.monitor_history_status_interval
    WHERE asin_key = ${asinKey} AND country = ${country}`);
  ensureOpen();
  const inserted = await db.execute(sql`
    INSERT INTO public.monitor_history_status_interval
      (asin_key, asin_id, asin_code, asin_name, country, variant_group_id,
       variant_group_name, interval_start, interval_end, is_broken)
    WITH ordered AS (
      SELECT mh.*, coalesce(is_broken, false) AS broken,
        lag(coalesce(is_broken, false)) OVER (ORDER BY check_time, id) AS previous_broken
      FROM public.monitor_history mh
      WHERE mh.country = ${country}
        AND public.neo_monitor_interval_key(mh.asin_code, mh.asin_id) = ${asinKey}
        AND rtrim(mh.check_type) COLLATE public.neo_import_group_ci = 'ASIN'
        AND (mh.asin_id IS NOT NULL OR nullif(rtrim(mh.asin_code), '') IS NOT NULL)
    ), transitions AS (
      SELECT *, date_trunc('second', check_time) AS starts,
        date_trunc('second', lead(check_time) OVER (ORDER BY check_time, id)) AS ends
      FROM ordered WHERE previous_broken IS DISTINCT FROM broken
    ), persisted AS (
      -- Legacy's ON DUPLICATE KEY UPDATE keeps the last transition within a
      -- second. Select it before insertion so PostgreSQL never updates a row
      -- twice in one INSERT; same-state checks retain the initial metadata.
      SELECT DISTINCT ON (starts) * FROM transitions
      ORDER BY starts, check_time DESC, id DESC
    )
    SELECT ${asinKey}, nullif(asin_id, ''),
      CASE WHEN nullif(rtrim(asin_code), '') IS NOT NULL THEN asin_code END,
      CASE WHEN nullif(rtrim(asin_name), '') IS NOT NULL THEN asin_name END,
      ${country}, nullif(variant_group_id, ''),
      CASE WHEN nullif(rtrim(variant_group_name), '') IS NOT NULL THEN variant_group_name END,
      starts, ends, broken FROM persisted
  `);
  ensureOpen();
  // Our interval writes also dirty the key. Complete them only after the entire
  // replacement; a concurrent source writer remains blocked until our commit.
  await db.execute(sql`UPDATE public.monitor_interval_dirty
    SET completed_revision = revision, active = ${(inserted.rowCount ?? 0) > 0},
      (first_check_time, last_check_time, source_relation_ids) = (
        SELECT date_trunc('second', min(check_time)), date_trunc('second', max(check_time)),
          coalesce(array_agg(DISTINCT tableoid::bigint), '{}'::bigint[])
        FROM public.monitor_history
        WHERE country = ${country}
          AND public.neo_monitor_interval_key(asin_code, asin_id) = ${asinKey}
          AND rtrim(check_type) COLLATE public.neo_import_group_ci = 'ASIN'
          AND (asin_id IS NOT NULL OR nullif(rtrim(asin_code), '') IS NOT NULL)
      )
    WHERE asin_key = ${asinKey} AND country = ${country}`);
  ensureOpen();
  return true;
}
