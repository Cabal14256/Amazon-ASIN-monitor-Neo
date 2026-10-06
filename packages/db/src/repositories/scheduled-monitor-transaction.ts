import type { Pool, PoolClient, QueryResultRow } from 'pg';
import { ScheduledMonitorRunError } from '../domain/scheduled-monitor-run';

export interface ScheduledMonitorTransaction {
  query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]): Promise<T[]>;
}
export class ScheduledMonitorSerializationRetry extends Error {}

/** No upstream I/O belongs here. A late connection still owns its capacity slot
 * until it can be destroyed. After COMMIT starts, an interruption is not rollback
 * evidence and must never be turned into a blind business retry. */
export class PgScheduledMonitorTransactions {
  private active = 0;
  private closed = false;
  private readonly stops = new Set<() => void>();
  constructor(
    private readonly pool: Pool,
    private readonly maximum = 4,
    private readonly durationMs = 15_000,
    private readonly statementTimeoutMs = 5000,
  ) {
    if (!Number.isInteger(maximum) || maximum < 1 || maximum > 16 ||
        !Number.isInteger(durationMs) || durationMs < 1000 || durationMs > 30_000 ||
        !Number.isInteger(statementTimeoutMs) || statementTimeoutMs < 100 || statementTimeoutMs >= durationMs)
      throw new ScheduledMonitorRunError('input');
  }
  getDiagnostics() { return { active: this.active, closed: this.closed }; }
  async run<T>(
    action: (transaction: ScheduledMonitorTransaction) => Promise<T>,
    signal?: AbortSignal,
    retryAdmissionConflict = false,
  ): Promise<T> {
    if (this.closed) throw new ScheduledMonitorRunError('closed');
    if (signal?.aborted) throw new ScheduledMonitorRunError('cancelled');
    if (this.active >= this.maximum) throw new ScheduledMonitorRunError('capacity');
    this.active++;
    let client: PoolClient | undefined, released = false, finished = false, commitStarted = false;
    let stopped: ScheduledMonitorRunError | undefined;
    let rejectInterrupt!: (error: ScheduledMonitorRunError) => void;
    const interrupted = new Promise<never>((_resolve, reject) => { rejectInterrupt = reject; });
    const release = (destroy: boolean) => {
      if (!client || released) return;
      released = true;
      client.removeListener('error', connectionError);
      client.release(destroy);
    };
    const stop = (code: 'dependency' | 'timeout' | 'cancelled' | 'closed') => {
      if (stopped || finished) return;
      stopped = new ScheduledMonitorRunError(commitStarted ? 'commit-uncertain' : code);
      release(true);
      rejectInterrupt(stopped);
    };
    const connectionError = () => stop('dependency');
    const abort = () => stop('cancelled');
    const close = () => stop('closed');
    const ensureOpen = () => {
      if (stopped) throw stopped;
      if (finished) throw new ScheduledMonitorRunError('closed');
    };
    const query: ScheduledMonitorTransaction['query'] = async (text, values) => {
      ensureOpen();
      if (!client) throw new ScheduledMonitorRunError('dependency');
      const result = await client.query(text, values);
      ensureOpen();
      return result.rows;
    };
    signal?.addEventListener('abort', abort, { once: true });
    this.stops.add(close);
    const timer = setTimeout(() => stop('timeout'), this.durationMs);
    if (signal?.aborted) abort();
    const work = (async () => {
      let confirmed = false;
      try {
        client = await this.pool.connect();
        if (stopped || finished) { release(true); ensureOpen(); }
        client.on('error', connectionError);
        await query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        await query(`SET LOCAL statement_timeout = ${this.statementTimeoutMs}`);
        await query(`SET LOCAL lock_timeout = ${this.statementTimeoutMs}`);
        await query(`SET LOCAL idle_in_transaction_session_timeout = ${this.durationMs}`);
        const result = await action({ query });
        ensureOpen();
        commitStarted = true;
        await query('COMMIT');
        confirmed = true;
        return result;
      } catch (error) {
        if (stopped) throw stopped;
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        // PostgreSQL explicitly rejects serialization/unique conflicts: no
        // COMMIT succeeded. An admission retry only freezes DB data, never I/O.
        if (code === '40001' || (retryAdmissionConflict && !commitStarted && code === '23505'))
          throw new ScheduledMonitorSerializationRetry();
        if (commitStarted) throw new ScheduledMonitorRunError('commit-uncertain');
        if (error instanceof ScheduledMonitorRunError) throw error;
        throw new ScheduledMonitorRunError(code === '57014' || code === '55P03' ? 'timeout' : 'dependency');
      } finally {
        finished = true;
        release(!confirmed);
        this.active--;
      }
    })();
    try { return await Promise.race([work, interrupted]); }
    finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.stops.delete(close);
    }
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const stop of this.stops) stop();
  }
}
