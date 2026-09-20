import type { Pool, PoolClient } from 'pg';
import { createDb, type Db } from '../client';
import type { CompetitorQueryUnit } from '../domain/competitor-query';
import { DrizzleAsinQueryUnit } from './asin-query-repository';

export class CompetitorTransactionError extends Error {
  constructor(
    readonly code:
      | 'capacity'
      | 'dependency'
      | 'timeout'
      | 'cancelled'
      | 'closed'
      | 'commit-uncertain',
  ) {
    super(`Competitor transaction ${code}`);
    this.name = 'CompetitorTransactionError';
  }
}
type Authorization = Pick<
  CompetitorQueryUnit,
  'lockOperator' | 'lockSession' | 'operatorPermissionCodes'
>;
interface Context {
  authorization: Authorization;
  database(): Promise<Db>;
  ensureOpen(): void;
}

/** Own borrowed clients, never the host pools. Keep primary authorization locked
 * until the distinct competitor transaction completes. No distributed commit. */
export class PgCompetitorTransactions {
  private active = 0;
  private closed = false;
  private readonly stops = new Set<() => void>();
  constructor(
    private readonly primary: Pool,
    private readonly competitor: Pool,
  ) {
    if (primary === competitor)
      throw new CompetitorTransactionError('dependency');
  }
  getDiagnostics() {
    return { pendingOperations: this.active, closed: this.closed };
  }
  async run<T>(
    readOnly: boolean,
    operation: (context: Context) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closed) throw new CompetitorTransactionError('closed');
    if (signal?.aborted) throw new CompetitorTransactionError('cancelled');
    if (this.active >= 8) throw new CompetitorTransactionError('capacity');
    this.active++;
    const clients = new Set<PoolClient>(),
      released = new Set<PoolClient>();
    let stopped: CompetitorTransactionError | undefined;
    let commitStarted = false;
    let finished = false;
    const failure = (code: CompetitorTransactionError['code']) =>
      new CompetitorTransactionError(
        !readOnly && commitStarted ? 'commit-uncertain' : code,
      );
    let rejectInterrupt!: (error: CompetitorTransactionError) => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectInterrupt = reject;
    });
    const release = (client: PoolClient, destroy: boolean) => {
      if (released.has(client)) return;
      released.add(client);
      client.removeListener('error', connectionError);
      client.release(destroy);
    };
    const stop = (code: 'dependency' | 'timeout' | 'cancelled' | 'closed') => {
      if (stopped) return;
      stopped = failure(code);
      for (const client of clients) release(client, true);
      rejectInterrupt(stopped);
    };
    const connectionError = () => stop('dependency');
    const abort = () => stop('cancelled');
    const close = () => stop('closed');
    const ensureOpen = () => {
      if (stopped) throw stopped;
      if (finished) throw new CompetitorTransactionError('closed');
    };
    const acquire = async (pool: Pool) => {
      ensureOpen();
      const client = await pool.connect();
      clients.add(client);
      if (stopped || finished) {
        release(client, true);
        ensureOpen();
      }
      client.on('error', connectionError);
      return client;
    };
    const query = async (client: PoolClient, text: string) => {
      ensureOpen();
      const result = await client.query(text);
      ensureOpen();
      return result;
    };
    signal?.addEventListener('abort', abort, { once: true });
    this.stops.add(close);
    const timer = setTimeout(() => stop('timeout'), 4000);
    if (signal?.aborted) abort();
    const work = (async () => {
      let success = false;
      try {
        const primary = await acquire(this.primary);
        await query(primary, 'BEGIN');
        await query(primary, 'SET LOCAL statement_timeout = 1500');
        await query(
          primary,
          'SELECT pg_advisory_xact_lock_shared(1095977294,1380073795)',
        );
        const primaryName = (
          await query(primary, 'SELECT current_database() AS name')
        ).rows[0]?.name;
        if (typeof primaryName !== 'string') throw failure('dependency');
        const auth = new DrizzleAsinQueryUnit(createDb(primary), ensureOpen);
        let businessClient: PoolClient | undefined,
          business: Promise<Db> | undefined;
        const acquireBusiness = async () => {
          businessClient = await acquire(this.competitor);
          await query(businessClient, readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
          await query(businessClient, 'SET LOCAL statement_timeout = 1500');
          const name = (
            await query(businessClient, 'SELECT current_database() AS name')
          ).rows[0]?.name;
          if (typeof name !== 'string' || name === primaryName)
            throw failure('dependency');
          return createDb(businessClient);
        };
        const result = await operation({
          authorization: {
            lockOperator: (id) => auth.lockOperator(id),
            lockSession: (user, session) => auth.lockSession(user, session),
            operatorPermissionCodes: (id) => auth.operatorPermissionCodes(id),
          },
          database: () => {
            ensureOpen();
            return (business ??= acquireBusiness());
          },
          ensureOpen,
        });
        ensureOpen();
        if (businessClient) {
          commitStarted = true;
          await query(businessClient, 'COMMIT');
        }
        await query(primary, 'COMMIT');
        success = true;
        return result;
      } catch (error) {
        // A driver error/timeout after COMMIT started cannot prove rollback.
        if (!readOnly && commitStarted) throw failure('commit-uncertain');
        throw error;
      } finally {
        finished = true;
        try {
          for (const client of clients) release(client, !success);
        } finally {
          this.active--;
        }
      }
    })();
    try {
      return await Promise.race([work, interrupted]);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.stops.delete(close);
      // Late acquisition continues owning its admission slot until work settles.
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const stop of this.stops) stop();
  }
}
