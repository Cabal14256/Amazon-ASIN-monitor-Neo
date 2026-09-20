import type { Pool, PoolClient } from 'pg';
import { createDb } from '../client';
import {
  CompetitorQueryError,
  type CompetitorQueryRepositoryPort,
  type CompetitorQueryUnit,
} from '../domain/competitor-query';
import { DrizzleAsinQueryUnit } from './asin-query-repository';
import { DrizzleCompetitorReadUnit } from './competitor-read-unit';

/** Hold current primary authorization until the distinct competitor read has
 * committed. Own borrowed clients only; the application owns both pools. */
export class PgCompetitorQueryRepository
  implements CompetitorQueryRepositoryPort
{
  private active = 0;
  private closed = false;
  private readonly stops = new Set<() => void>();
  constructor(
    private readonly primary: Pool,
    private readonly competitor: Pool,
  ) {
    if (primary === competitor) throw new CompetitorQueryError('dependency');
  }
  getDiagnostics() {
    return { pendingReads: this.active, closed: this.closed };
  }
  async read<T>(
    operation: (unit: CompetitorQueryUnit) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.closed) throw new CompetitorQueryError('closed');
    if (signal?.aborted) throw new CompetitorQueryError('cancelled');
    if (this.active >= 8) throw new CompetitorQueryError('capacity');
    this.active++;
    const clients = new Set<PoolClient>();
    const released = new Set<PoolClient>();
    let stopped: CompetitorQueryError | undefined;
    let rejectInterrupt!: (error: CompetitorQueryError) => void;
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
      stopped = new CompetitorQueryError(code);
      for (const client of clients) release(client, true);
      rejectInterrupt(stopped);
    };
    const connectionError = () => stop('dependency');
    const abort = () => stop('cancelled');
    const close = () => stop('closed');
    const ensure = () => {
      if (stopped) throw stopped;
    };
    const acquire = async (pool: Pool) => {
      ensure();
      const client = await pool.connect();
      clients.add(client);
      if (stopped) {
        release(client, true);
        throw stopped;
      }
      client.on('error', connectionError);
      return client;
    };
    const query = async (client: PoolClient, text: string) => {
      ensure();
      const result = await client.query(text);
      ensure();
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
        // FOR SHARE account/session locks require a regular transaction.
        await query(primary, 'BEGIN');
        await query(primary, 'SET LOCAL statement_timeout = 1500');
        await query(
          primary,
          'SELECT pg_advisory_xact_lock_shared(1095977294,1380073795)',
        );
        const primaryName = (
          await query(primary, 'SELECT current_database() AS name')
        ).rows[0]?.name;
        if (typeof primaryName !== 'string')
          throw new CompetitorQueryError('dependency');
        const auth = new DrizzleAsinQueryUnit(createDb(primary), ensure);
        let businessClient: PoolClient | undefined;
        let queried = false;
        const business = async () => {
          ensure();
          // A public list/detail action issues exactly one bounded snapshot.
          if (queried) throw new CompetitorQueryError('capacity');
          queried = true;
          businessClient = await acquire(this.competitor);
          await query(businessClient, 'BEGIN READ ONLY');
          await query(businessClient, 'SET LOCAL statement_timeout = 1500');
          const name = (
            await query(businessClient, 'SELECT current_database() AS name')
          ).rows[0]?.name;
          if (typeof name !== 'string' || name === primaryName)
            throw new CompetitorQueryError('dependency');
          return new DrizzleCompetitorReadUnit(
            createDb(businessClient),
            ensure,
          );
        };
        const result = await operation({
          lockOperator: (id) => auth.lockOperator(id),
          lockSession: (user, session) => auth.lockSession(user, session),
          operatorPermissionCodes: (id) => auth.operatorPermissionCodes(id),
          list: async (value) => (await business()).list(value),
          detail: async (id) => (await business()).detail(id),
        });
        ensure();
        if (businessClient) await query(businessClient, 'COMMIT');
        // The primary authorization locks are still held through the above commit.
        await query(primary, 'COMMIT');
        success = true;
        return result;
      } finally {
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
      // A late pool acquisition still owns an admission slot until work settles.
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const stop of this.stops) stop();
  }
}
