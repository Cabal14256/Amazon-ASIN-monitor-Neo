import { sql } from 'drizzle-orm';
import type { Pool, PoolClient } from 'pg';
import { createDb, type Db } from '../client';
import type { CatalogPhysicalOutcome } from '../domain/catalog-operation';
import type { CompetitorQueryUnit } from '../domain/competitor-query';
import { spApiConfig } from '../schema';
import { DrizzleAsinQueryUnit } from './asin-query-repository';
import { catalogTransactionExecution } from './catalog-operation-execution';

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
> & {
  competitorMonitorConfiguration(): Promise<string | null | undefined>;
};
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
    private readonly maximumOperations = 8,
    private readonly limits: {
      durationMs: number;
      statementTimeoutMs: number;
    } = { durationMs: 4000, statementTimeoutMs: 1500 },
  ) {
    if (
      primary === competitor ||
      !Number.isInteger(maximumOperations) ||
      maximumOperations < 1 ||
      maximumOperations > 16 ||
      !Number.isInteger(limits.durationMs) ||
      limits.durationMs < 1000 ||
      limits.durationMs > 30000 ||
      !Number.isInteger(limits.statementTimeoutMs) ||
      limits.statementTimeoutMs < 500 ||
      limits.statementTimeoutMs >= limits.durationMs
    )
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
    if (this.active >= this.maximumOperations)
      throw new CompetitorTransactionError('capacity');
    const execution = catalogTransactionExecution();
    // Preserve synchronous capacity admission for ordinary unscoped reads.
    // Fenced execution waits for its durable pin before any borrowed DB work.
    if (execution.scoped) await execution.begin();
    else void execution.begin();
    if (
      this.closed ||
      signal?.aborted ||
      this.active >= this.maximumOperations
    ) {
      await execution.settled('rolled-back');
      throw new CompetitorTransactionError(
        this.closed ? 'closed' : signal?.aborted ? 'cancelled' : 'capacity',
      );
    }
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
    const timer = setTimeout(() => stop('timeout'), this.limits.durationMs);
    if (signal?.aborted) abort();
    const work = (async () => {
      let success = false;
      let outcome: CatalogPhysicalOutcome = 'uncertain';
      try {
        const primary = await acquire(this.primary);
        await query(primary, 'BEGIN');
        await query(
          primary,
          `SET LOCAL statement_timeout = ${this.limits.statementTimeoutMs}`,
        );
        await query(
          primary,
          'SELECT pg_advisory_xact_lock_shared(1095977294,1380073795)',
        );
        const primaryName = (
          await query(primary, 'SELECT current_database() AS name')
        ).rows[0]?.name;
        if (typeof primaryName !== 'string') throw failure('dependency');
        const primaryDb = createDb(primary);
        await execution.guard(primaryDb);
        ensureOpen();
        const auth = new DrizzleAsinQueryUnit(primaryDb, ensureOpen);
        let businessClient: PoolClient | undefined,
          business: Promise<Db> | undefined;
        const acquireBusiness = async () => {
          businessClient = await acquire(this.competitor);
          await query(businessClient, readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
          await query(
            businessClient,
            `SET LOCAL statement_timeout = ${this.limits.statementTimeoutMs}`,
          );
          const name = (
            await query(businessClient, 'SELECT current_database() AS name')
          ).rows[0]?.name;
          if (typeof name !== 'string' || name === primaryName)
            throw failure('dependency');
          const db = createDb(businessClient);
          execution.allowBusinessDatabase(db);
          return db;
        };
        const result = await operation({
          authorization: {
            lockOperator: (id) => auth.lockOperator(id),
            lockSession: (user, session) => auth.lockSession(user, session),
            operatorPermissionCodes: (id) => auth.operatorPermissionCodes(id),
            competitorMonitorConfiguration: async () => {
              ensureOpen();
              const rows = await createDb(primary)
                .select({
                  value: sql<
                    string | null
                  >`left(${spApiConfig.configValue},4097)`,
                })
                .from(spApiConfig)
                .where(
                  sql`lower(${spApiConfig.configKey}) = 'competitor_monitor_enabled'`,
                )
                .limit(2);
              ensureOpen();
              if (
                rows.length > 1 ||
                (rows[0]?.value !== null &&
                  (rows[0]?.value?.length ?? 0) > 4096)
              )
                throw failure('dependency');
              return rows[0]?.value;
            },
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
        outcome = 'committed';
        return result;
      } catch (error) {
        if (execution.scoped && !stopped && !commitStarted) {
          try {
            for (const client of clients) await query(client, 'ROLLBACK');
            outcome = 'rolled-back';
          } catch {
            // A disconnected/destroyed transaction is not physical-stop proof.
          }
        }
        // A driver error/timeout after COMMIT started cannot prove rollback.
        if (!readOnly && commitStarted) throw failure('commit-uncertain');
        throw error;
      } finally {
        finished = true;
        try {
          for (const client of clients) release(client, !success);
        } finally {
          this.active--;
          // Report only after this real work promise and both DB clients settle.
          // The outer Promise.race can already have returned an error.
          await execution.settled(outcome);
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
