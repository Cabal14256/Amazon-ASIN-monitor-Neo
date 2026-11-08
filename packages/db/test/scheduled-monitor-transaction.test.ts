import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ScheduledMonitorRunError } from '../src/domain/scheduled-monitor-run';
import {
  PgScheduledMonitorTransactions,
  ScheduledMonitorSerializationRetry,
  type ScheduledMonitorTransaction,
} from '../src/repositories/scheduled-monitor-transaction';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const query = vi.fn(async (_text: string, _values?: unknown[]) => ({
    rows: [],
  }));
  const release = vi.fn();
  const events = new EventEmitter();
  const client = Object.assign(events, {
    query,
    release,
  }) as unknown as PoolClient;
  const connect = vi.fn(async () => client);
  const pool = { connect } as unknown as Pool;
  const transactions = new PgScheduledMonitorTransactions(pool, 1, 1200, 100);
  return { query, release, events, client, connect, transactions };
}
afterEach(() => vi.useRealTimers());
describe('scheduled monitor transaction ownership and uncertainty', () => {
  it('uses local bounded limits and confirms exactly one database COMMIT', async () => {
    const { transactions, query, release } = fixture();
    await expect(
      transactions.run(async (tx) => {
        await tx.query('SELECT private', [1]);
        return 'frozen';
      }),
    ).resolves.toBe('frozen');
    expect(query.mock.calls.map(([text]) => text)).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ',
      'SET LOCAL statement_timeout = 100',
      'SET LOCAL lock_timeout = 100',
      'SET LOCAL idle_in_transaction_session_timeout = 1200',
      'SELECT private',
      'COMMIT',
    ]);
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
    expect(transactions.getDiagnostics()).toEqual({ active: 0, closed: false });
  });
  it('never converts a lost COMMIT acknowledgment to a safe retry', async () => {
    const { transactions, query, release } = fixture();
    query.mockImplementation(async (text) => {
      if (text === 'COMMIT') throw new Error('wire lost');
      return { rows: [] };
    });
    await expect(
      transactions.run(async () => 'business'),
    ).rejects.toMatchObject({ code: 'commit-uncertain' });
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it.each(['57014', '55P03'])(
    'reports PostgreSQL deadline %s before COMMIT as bounded timeout',
    async (code) => {
      const { transactions, release } = fixture();
      await expect(
        transactions.run(async () => {
          throw { code };
        }),
      ).rejects.toMatchObject({ code: 'timeout' });
      expect(release).toHaveBeenCalledExactlyOnceWith(true);
    },
  );
  it('permits only explicit serialization/admission conflicts to request a DB-only retry', async () => {
    const { transactions } = fixture();
    await expect(
      transactions.run(async () => {
        throw { code: '40001' };
      }),
    ).rejects.toBeInstanceOf(ScheduledMonitorSerializationRetry);
    await expect(
      transactions.run(
        async () => {
          throw { code: '23505' };
        },
        undefined,
        true,
      ),
    ).rejects.toBeInstanceOf(ScheduledMonitorSerializationRetry);
    await expect(
      transactions.run(async () => {
        throw { code: '23505' };
      }),
    ).rejects.toMatchObject({ code: 'dependency' });
  });
  it('bounds capacity while an interrupted late connection still owns its slot', async () => {
    vi.useFakeTimers();
    const { transactions, connect, client, release } = fixture();
    const connection = deferred<PoolClient>();
    connect.mockReturnValueOnce(connection.promise);
    const first = transactions.run(async () => 'must not execute');
    const rejection = expect(first).rejects.toMatchObject({ code: 'timeout' });
    await vi.advanceTimersByTimeAsync(1200);
    await rejection;
    expect(transactions.getDiagnostics().active).toBe(1);
    await expect(transactions.run(async () => 'new')).rejects.toMatchObject({
      code: 'capacity',
    });
    connection.resolve(client);
    await vi.advanceTimersByTimeAsync(0);
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
    expect(transactions.getDiagnostics().active).toBe(0);
  });
  it('cancels waiting SQL before COMMIT and destroys the owned connection once', async () => {
    const { transactions, query, release } = fixture();
    const sql = deferred<{ rows: never[] }>();
    const started = deferred<void>();
    query.mockImplementation(async (text) => {
      if (text === 'SELECT blocked') {
        started.resolve();
        return sql.promise;
      }
      return { rows: [] };
    });
    const controller = new AbortController();
    const work = transactions.run(
      (tx) => tx.query('SELECT blocked'),
      controller.signal,
    );
    const rejection = expect(work).rejects.toMatchObject({ code: 'cancelled' });
    await started.promise;
    controller.abort();
    await rejection;
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
    sql.resolve({ rows: [] });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(query.mock.calls.some(([text]) => text === 'COMMIT')).toBe(false);
    expect(transactions.getDiagnostics().active).toBe(0);
  });
  it('reports cancellation after COMMIT was sent as uncertain and prevents any later query', async () => {
    const { transactions, query, release } = fixture();
    const commit = deferred<{ rows: never[] }>(),
      started = deferred<void>();
    query.mockImplementation(async (text) => {
      if (text === 'COMMIT') {
        started.resolve();
        return commit.promise;
      }
      return { rows: [] };
    });
    const controller = new AbortController();
    const work = transactions.run(async () => 'result', controller.signal);
    const rejection = expect(work).rejects.toMatchObject({
      code: 'commit-uncertain',
    });
    await started.promise;
    controller.abort();
    await rejection;
    commit.resolve({ rows: [] });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
    expect(transactions.getDiagnostics().active).toBe(0);
  });
  it('fails closed on a connection error and shutdown, without ending the host pool', async () => {
    const { transactions, query, release, events } = fixture();
    const sql = deferred<{ rows: never[] }>(),
      started = deferred<void>();
    query.mockImplementation(async (text) => {
      if (text === 'SELECT blocked') {
        started.resolve();
        return sql.promise;
      }
      return { rows: [] };
    });
    const work = transactions.run((tx) => tx.query('SELECT blocked'));
    const rejection = expect(work).rejects.toMatchObject({
      code: 'dependency',
    });
    await started.promise;
    events.emit('error', new Error('connection lost'));
    await rejection;
    transactions.close();
    await expect(transactions.run(async () => 'new')).rejects.toMatchObject({
      code: 'closed',
    });
    sql.resolve({ rows: [] });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('rejects malformed deadlines and pre-cancelled admission without borrowing a client', async () => {
    const { transactions, connect } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      transactions.run(async () => 'new', controller.signal),
    ).rejects.toBeInstanceOf(ScheduledMonitorRunError);
    expect(connect).not.toHaveBeenCalled();
    expect(() => new PgScheduledMonitorTransactions({} as Pool, 0)).toThrow();
    expect(
      () => new PgScheduledMonitorTransactions({} as Pool, 1, 1000, 1000),
    ).toThrow();
  });
  it.each([NaN, Infinity, -Infinity])(
    'rejects non-finite logical deadline %s before taking physical capacity',
    async (deadline) => {
      const { transactions, connect } = fixture();
      // An optional fourth argument is compatible with the original three-arg
      // interface. The original implementation must fail on behavior, rather
      // than failing because the proposed deadline method does not exist yet.
      const run: <T>(
        action: (tx: ScheduledMonitorTransaction) => Promise<T>,
        signal?: AbortSignal,
        admission?: boolean,
        deadline?: number,
      ) => Promise<T> = transactions.run.bind(transactions);
      try {
        await expect(
          run(async () => 'must not execute', undefined, false, deadline),
        ).rejects.toMatchObject({ code: 'input' });
        expect(connect).not.toHaveBeenCalled();
        expect(transactions.getDiagnostics().active).toBe(0);
      } finally {
        transactions.close();
      }
    },
  );
  it('rejects an exhausted logical deadline without borrowing a client', async () => {
    const { transactions, connect } = fixture();
    const run: <T>(
      action: (tx: ScheduledMonitorTransaction) => Promise<T>,
      signal?: AbortSignal,
      admission?: boolean,
      deadline?: number,
    ) => Promise<T> = transactions.run.bind(transactions);
    try {
      await expect(
        run(
          async () => 'must not execute',
          undefined,
          false,
          performance.now() - 1,
        ),
      ).rejects.toMatchObject({ code: 'timeout' });
      expect(connect).not.toHaveBeenCalled();
      expect(transactions.getDiagnostics().active).toBe(0);
    } finally {
      transactions.close();
    }
  });
  it('uses only the remaining logical budget while a retry acquires a late connection', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const { transactions, connect, client, release } = fixture();
    const connection = deferred<PoolClient>();
    const run: <T>(
      action: (tx: ScheduledMonitorTransaction) => Promise<T>,
      signal?: AbortSignal,
      admission?: boolean,
      deadline?: number,
    ) => Promise<T> = transactions.run.bind(transactions);
    const deadline = performance.now() + 1200;
    let settled: unknown;
    let work: Promise<void> | undefined;
    try {
      expect(await run(async () => 'first', undefined, false, deadline)).toBe(
        'first',
      );
      expect(release).toHaveBeenCalledExactlyOnceWith(false);
      await vi.advanceTimersByTimeAsync(800);
      connect.mockReturnValueOnce(connection.promise);
      work = run(
        async () => 'must not execute',
        undefined,
        false,
        deadline,
      ).then(
        (value) => {
          settled = value;
        },
        (error: unknown) => {
          settled = error;
        },
      );
      await vi.advanceTimersByTimeAsync(399);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toMatchObject({ code: 'timeout' });
      expect(connect).toHaveBeenCalledTimes(2);
      expect(transactions.getDiagnostics().active).toBe(1);
      await expect(transactions.run(async () => 'new')).rejects.toMatchObject({
        code: 'capacity',
      });
      connection.resolve(client);
      await vi.advanceTimersByTimeAsync(0);
      await work;
      expect(release.mock.calls).toEqual([[false], [true]]);
      expect(transactions.getDiagnostics().active).toBe(0);
    } finally {
      transactions.close();
      connection.resolve(client);
      await vi.advanceTimersByTimeAsync(0);
      await work;
    }
  });
});
