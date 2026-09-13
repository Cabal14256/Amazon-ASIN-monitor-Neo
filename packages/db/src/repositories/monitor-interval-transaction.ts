import type { Pool, PoolClient } from 'pg';
import { createDb, type Db } from '../client';

export class MonitorIntervalTransactionError extends Error {
  constructor(readonly code: 'capacity' | 'timeout' | 'closed') {
    super('Monitor interval transaction could not be completed');
  }
}
/** Dedicated maintenance transactions never hold administration/auth locks.
 * Admission includes pool acquisition; shutdown cancels active transactions.
 */
export class MonitorIntervalTransaction {
  private active = 0;
  private closed = false;
  private readonly cancel = new Set<() => void>();
  constructor(private readonly pool: Pool) {}
  close() {
    this.closed = true;
    for (const cancel of this.cancel) cancel();
  }
  run<T>(action: (db: Db, ensureOpen: () => void) => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(new MonitorIntervalTransactionError('closed'));
    if (this.active >= 2)
      return Promise.reject(new MonitorIntervalTransactionError('capacity'));
    this.active++;
    const expires = Date.now() + 15_000;
    let client: PoolClient | undefined,
      released = false,
      expired = false;
    let rejectFailure!: (error: unknown) => void;
    const failure = new Promise<never>((_, reject) => {
      rejectFailure = reject;
    });
    const destroy = () => {
      expired = true;
      if (client && !released) {
        released = true;
        client.release(true);
      }
    };
    const ensureOpen = () => {
      if (this.closed) throw new MonitorIntervalTransactionError('closed');
      if (expired || Date.now() >= expires)
        throw new MonitorIntervalTransactionError('timeout');
    };
    const cancel = () => {
      destroy();
      rejectFailure(
        new MonitorIntervalTransactionError(this.closed ? 'closed' : 'timeout'),
      );
    };
    this.cancel.add(cancel);
    const timer = setTimeout(cancel, 15_000);
    const work = (async () => {
      try {
        client = await this.pool.connect();
        if (expired || this.closed || Date.now() >= expires) {
          released = true;
          client.release();
          ensureOpen();
        }
        client.on('error', rejectFailure);
        ensureOpen();
        await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
        ensureOpen();
        await client.query('SET LOCAL statement_timeout = 10000');
        ensureOpen();
        await client.query('SET LOCAL lock_timeout = 1500');
        ensureOpen();
        const value = await action(createDb(client), ensureOpen);
        ensureOpen();
        await client.query('COMMIT');
        ensureOpen();
        return value;
      } finally {
        this.active--;
      }
    })();
    return Promise.race([work, failure])
      .catch((error) => {
        destroy();
        throw error;
      })
      .finally(() => {
        clearTimeout(timer);
        this.cancel.delete(cancel);
        expired = true;
        client?.removeListener('error', rejectFailure);
        if (client && !released) {
          released = true;
          client.release();
        }
      });
  }
}
