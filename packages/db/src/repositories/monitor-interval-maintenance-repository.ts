import { sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { reconcileMonitorInterval } from './monitor-interval-projection';
import {
  MonitorIntervalTransaction,
  MonitorIntervalTransactionError,
} from './monitor-interval-transaction';

export interface MonitorIntervalMaintenanceResult {
  processed: boolean;
  deferred: boolean;
}
export interface MonitorIntervalMaintenanceRepositoryPort {
  reconcile(): Promise<MonitorIntervalMaintenanceResult>;
}
function retryable(error: unknown) {
  if (error instanceof MonitorIntervalTransactionError)
    return error.code === 'timeout';
  for (
    let depth = 0;
    depth < 2 && error && typeof error === 'object';
    depth++
  ) {
    const current = error as { code?: unknown; cause?: unknown };
    if (['57014', '55P03', '40P01', '40001'].includes(String(current.code)))
      return true;
    error = current.cause;
  }
  return false;
}
export class PgMonitorIntervalMaintenanceRepository
  implements MonitorIntervalMaintenanceRepositoryPort
{
  private readonly transactions: MonitorIntervalTransaction;
  constructor(pool: Pool) {
    this.transactions = new MonitorIntervalTransaction(pool);
  }
  close() {
    this.transactions.close();
  }
  async reconcile(): Promise<MonitorIntervalMaintenanceResult> {
    let claimed: { asinKey: string; country: string } | undefined;
    try {
      const processed = await this.transactions.run((db, ensureOpen) =>
        reconcileMonitorInterval(db, ensureOpen, (key) => {
          claimed = key;
        }),
      );
      return { processed, deferred: false };
    } catch (error) {
      if (!claimed || !retryable(error)) throw error;
      // The failed transaction has been destroyed/rolled back. Back off this
      // still-dirty key durably so one slow key cannot starve the whole queue.
      // A lost COMMIT acknowledgement may leave it clean; delaying a clean key
      // does not invalidate coverage or change its completed version.
      const { asinKey, country } = claimed;
      await this.transactions.run(async (db, ensureOpen) => {
        await db.execute(sql`UPDATE public.monitor_interval_dirty
          SET retry_after = clock_timestamp() + interval '30 seconds', queued_at = clock_timestamp()
          WHERE asin_key = ${asinKey} AND country = ${country}`);
        ensureOpen();
      });
      return { processed: false, deferred: true };
    }
  }
}
