import { sql, type SQL } from 'drizzle-orm';
import type { Db } from '../client';
import { MonitorAnalyticsQueryError } from '../domain/monitor-analytics-query';

const active = new WeakSet<Db>();
export const MONITOR_ANALYTICS_SOURCE_ROW_LIMIT = 5_000_000;
/** Consume a trusted SELECT on the caller's exclusively held transaction client.
 * Its entire SELECT (including coverage/count/page CTEs) keeps one snapshot as
 * FETCH advances, without retaining every source bucket in application memory.
 * The caller must bound transaction lifetime and accumulator/result state too.
 *
 * SAVEPOINT precedes DECLARE: rolling back closes a failed cursor and recovers
 * the transaction before a raw fallback. An already failed cursor is unusable.
 * https://www.postgresql.org/docs/16/sql-rollback-to.html
 */
export async function consumeMonitorAnalyticsRows(
  db: Db,
  select: SQL,
  visitBatch: (
    rows: readonly Record<string, unknown>[],
  ) => void | boolean | Promise<void | boolean>,
  ensureOpen: () => void,
  maximumRows = MONITOR_ANALYTICS_SOURCE_ROW_LIMIT,
): Promise<number> {
  if (
    !Number.isSafeInteger(maximumRows) ||
    maximumRows < 1 ||
    maximumRows > MONITOR_ANALYTICS_SOURCE_ROW_LIMIT
  )
    throw new MonitorAnalyticsQueryError('input');
  if (active.has(db)) throw new MonitorAnalyticsQueryError('capacity');
  active.add(db);
  let saved = false;
  try {
    ensureOpen();
    await db.execute(sql`SAVEPOINT monitor_analytics_rows`);
    saved = true;
    ensureOpen();
    await db.execute(
      sql`DECLARE monitor_analytics_rows_cursor NO SCROLL CURSOR FOR ${select}`,
    );
    let count = 0,
      finished = false;
    while (!finished) {
      ensureOpen();
      const batch = await db.execute(
        sql`FETCH FORWARD 1000 FROM monitor_analytics_rows_cursor`,
      );
      ensureOpen();
      count += batch.rows.length;
      if (count > maximumRows) throw new MonitorAnalyticsQueryError('capacity');
      if (batch.rows.length && (await visitBatch(batch.rows)) === false)
        finished = true;
      if (batch.rows.length < 1000) finished = true;
    }
    ensureOpen();
    await db.execute(sql`CLOSE monitor_analytics_rows_cursor`);
    ensureOpen();
    await db.execute(sql`RELEASE SAVEPOINT monitor_analytics_rows`);
    return count;
  } catch (error) {
    if (saved) {
      // A failed rollback is intentionally propagated; the transaction owner
      // must discard that connection rather than attempt another data query.
      ensureOpen();
      await db.execute(sql`ROLLBACK TO SAVEPOINT monitor_analytics_rows`);
      ensureOpen();
      await db.execute(sql`RELEASE SAVEPOINT monitor_analytics_rows`);
    }
    throw error;
  } finally {
    active.delete(db);
  }
}
