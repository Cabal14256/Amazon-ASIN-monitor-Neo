import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonitorIntervalTransaction } from '../src/repositories/monitor-interval-transaction';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture() {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (_query?: unknown) => ({ rows: [] })),
    release: vi.fn(),
  });
  const connect = vi.fn(async () => client as unknown as PoolClient);
  return {
    client,
    connect,
    transactions: new MonitorIntervalTransaction({
      connect,
    } as unknown as Pool),
  };
}
describe('monitor interval maintenance transaction lifetime', () => {
  afterEach(() => vi.useRealTimers());
  it('commits with its own deadlines without holding any authentication administration lock', async () => {
    const { client, transactions } = fixture();
    expect(await transactions.run(async () => 7)).toBe(7);
    expect(client.query.mock.calls.map(([query]) => query)).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
      'SET LOCAL statement_timeout = 10000',
      'SET LOCAL lock_timeout = 1500',
      'COMMIT',
    ]);
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
    expect(client.listenerCount('error')).toBe(0);
  });
  it('retains its two admission slots until late pool acquisitions settle and releases them without starting SQL', async () => {
    vi.useFakeTimers();
    const { connect, client, transactions } = fixture();
    const acquired = deferred<PoolClient>();
    connect.mockReturnValue(acquired.promise);
    const jobs = Array.from({ length: 2 }, () =>
      transactions.run(async () => 1).catch((error) => error),
    );
    await vi.advanceTimersByTimeAsync(15000);
    for (const error of await Promise.all(jobs))
      expect(error).toMatchObject({ code: 'timeout' });
    await expect(transactions.run(async () => 1)).rejects.toMatchObject({
      code: 'capacity',
    });
    acquired.resolve(client as unknown as PoolClient);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.query).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(2);
    expect(await transactions.run(async () => 2)).toBe(2);
  });
  it('shutdown destroys an active transaction and prevents all late commits and new jobs', async () => {
    const { client, transactions } = fixture();
    const blocked = deferred<void>();
    const result = transactions
      .run(async (_db, ensureOpen) => {
        await blocked.promise;
        ensureOpen();
      })
      .catch((error) => error);
    await vi.waitFor(() => expect(client.query).toHaveBeenCalledTimes(3));
    transactions.close();
    expect(await result).toMatchObject({ code: 'closed' });
    blocked.resolve();
    await expect(transactions.run(async () => 1)).rejects.toMatchObject({
      code: 'closed',
    });
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.query.mock.calls.some(([query]) => query === 'COMMIT')).toBe(
      false,
    );
  });
  it('checks elapsed wall time before commit even when synchronous work prevents timer delivery', async () => {
    vi.useFakeTimers();
    const { client, transactions } = fixture();
    await expect(
      transactions.run(async () => {
        vi.setSystemTime(Date.now() + 15001);
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.query.mock.calls.some(([query]) => query === 'COMMIT')).toBe(
      false,
    );
  });
});
