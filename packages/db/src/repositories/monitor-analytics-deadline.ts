import type { Pool, PoolClient } from 'pg';
import { createDb, type Db } from '../client';
import { MonitorAnalyticsQueryError } from '../domain/monitor-analytics-query';

/** Analytics owns its limits; authentication and other users of the pool retain
 * their existing short deadlines. Admission includes pending pool acquisition.
 * Keep READ COMMITTED: authorization is read after the shared administration
 * lock is acquired, even if an administrator changed roles while we waited.
 */
export class MonitorAnalyticsDeadline {
  private active = 0;
  constructor(private readonly pool: Pool) {}

  run<T>(
    operation: (db: Db, ensureOpen: () => void) => Promise<T>,
  ): Promise<T> {
    if (this.active >= 4)
      return Promise.reject(new MonitorAnalyticsQueryError('capacity'));
    this.active++;
    let client: PoolClient | undefined;
    let closed = false;
    let released = false;
    const expires = Date.now() + 10_000;
    const destroy = () => {
      closed = true;
      if (client && !released) {
        released = true;
        client.release(true);
      }
    };
    const ensureOpen = () => {
      if (closed || Date.now() >= expires)
        throw new MonitorAnalyticsQueryError('timeout');
    };
    let timer: ReturnType<typeof setTimeout>;
    let connectionError: (error: Error) => void;
    const failedConnection = new Promise<never>((_, reject) => {
      connectionError = reject;
    });
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        try {
          destroy();
        } finally {
          reject(new MonitorAnalyticsQueryError('timeout'));
        }
      }, 10_000);
    });
    const work = (async () => {
      try {
        client = await this.pool.connect();
        if (closed || Date.now() >= expires) {
          released = true;
          client.release();
          throw new MonitorAnalyticsQueryError('timeout');
        }
        client.on('error', connectionError!);
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        ensureOpen();
        await client.query('SET LOCAL statement_timeout = 1500');
        ensureOpen();
        await client.query('SET LOCAL lock_timeout = 1500');
        ensureOpen();
        await client.query(
          'SELECT pg_advisory_xact_lock_shared(1095977294,1380073795)',
        );
        ensureOpen();
        const value = await operation(createDb(client), ensureOpen);
        ensureOpen();
        await client.query('COMMIT');
        ensureOpen();
        return value;
      } finally {
        // A late pool acquisition cannot grow the queue by freeing admission
        // before it actually settles. Active callbacks also retain their slot.
        this.active--;
      }
    })();
    return Promise.race([work, timeout, failedConnection])
      .catch((error) => {
        destroy();
        throw error;
      })
      .finally(() => {
        clearTimeout(timer!);
        closed = true;
        if (client) {
          client.removeListener('error', connectionError!);
          if (!released) {
            released = true;
            client.release();
          }
        }
      });
  }
}
