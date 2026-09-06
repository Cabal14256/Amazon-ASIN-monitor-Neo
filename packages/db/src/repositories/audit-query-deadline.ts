import type { Pool, PoolClient } from 'pg';
import { createDb, type Db } from '../client';

function isStatementTimeout(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('code' in error && error.code === '57014') return true;
  return (
    'cause' in error &&
    typeof error.cause === 'object' &&
    error.cause !== null &&
    'code' in error.cause &&
    error.cause.code === '57014'
  );
}

export class AuditQueryError extends Error {
  constructor(
    readonly reason: 'capacity' | 'timeout' | 'unavailable' | 'invalid-result',
  ) {
    super(`Audit query ${reason}`);
    this.name = 'AuditQueryError';
  }
}

/** Bound acquisition and I/O without changing shared pool timeouts or write transactions. */
export class AuditQueryDeadline {
  private active = 0;
  constructor(private readonly pool: Pool) {}

  run<T>(
    operation: (db: Db, ensureOpen: () => void) => Promise<T>,
  ): Promise<T> {
    if (this.active >= 8)
      return Promise.reject(new AuditQueryError('capacity'));
    this.active++;
    return new Promise<T>((resolve, reject) => {
      let client: PoolClient | undefined;
      let settled = false;
      let released = false;
      const releaseSlot = () => {
        if (!released) {
          released = true;
          this.active--;
        }
      };
      const ensureOpen = () => {
        if (settled) throw new AuditQueryError('timeout');
      };
      const finish = (value?: T, error?: AuditQueryError) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        let failure = error;
        if (client) {
          client.removeListener('error', onError);
          try {
            client.release(Boolean(error));
          } catch {
            failure ??= new AuditQueryError('unavailable');
          } finally {
            releaseSlot();
          }
        }
        if (failure) reject(failure);
        else resolve(value!);
      };
      const onError = () =>
        finish(undefined, new AuditQueryError('unavailable'));
      const timer = setTimeout(
        () => finish(undefined, new AuditQueryError('timeout')),
        5000,
      );
      void Promise.resolve()
        .then(() => this.pool.connect())
        .then(async (acquired) => {
          if (settled) {
            acquired.release();
            releaseSlot();
            return;
          }
          client = acquired;
          client.on('error', onError);
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          ensureOpen();
          await client.query('SET LOCAL statement_timeout = 4000');
          ensureOpen();
          const value = await operation(createDb(client), ensureOpen);
          ensureOpen();
          await client.query('COMMIT');
          finish(value);
        })
        .catch((error: unknown) => {
          finish(
            undefined,
            error instanceof AuditQueryError
              ? error
              : new AuditQueryError(
                  isStatementTimeout(error) ? 'timeout' : 'unavailable',
                ),
          );
          releaseSlot();
        });
    });
  }
}
