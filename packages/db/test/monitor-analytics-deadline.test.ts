import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MonitorAnalyticsDeadline } from '../src/repositories/monitor-analytics-deadline';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn(async (_query?: unknown) => ({ rows: [] })),
    release: vi.fn(),
  });
  const connect = vi.fn(async () => client as unknown as PoolClient);
  const deadline = new MonitorAnalyticsDeadline({ connect } as unknown as Pool);
  return { deadline, connect, client };
}
describe('monitor analytics transaction lifetime', () => {
  afterEach(() => vi.useRealTimers());
  it('waits for the shared lock before current authorization and commits only after the callback', async () => {
    const { deadline, client } = fixture();
    const held = deferred<{ rows: never[] }>();
    client.query.mockImplementation(async (query?: unknown) => {
      if (String(query).includes('pg_advisory_xact_lock_shared'))
        return held.promise;
      return { rows: [] };
    });
    const action = vi.fn(async () => 42);
    const task = deadline.run(action);
    await vi.waitFor(() => expect(client.query).toHaveBeenCalledTimes(4));
    expect(action).not.toHaveBeenCalled();
    held.resolve({ rows: [] });
    expect(await task).toBe(42);
    expect(client.query.mock.calls[0]).toEqual([
      'BEGIN ISOLATION LEVEL READ COMMITTED',
    ]);
    expect(client.query.mock.calls.at(-1)).toEqual(['COMMIT']);
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
    expect(client.listenerCount('error')).toBe(0);
  });
  it('bounds pending pool acquisition and retains all four admission slots until those acquisitions settle', async () => {
    vi.useFakeTimers();
    const { deadline, connect, client } = fixture();
    const pending = deferred<PoolClient>();
    connect.mockReturnValue(pending.promise);
    const jobs = Array.from({ length: 4 }, () =>
      deadline.run(async () => 1).catch((error) => error),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    for (const result of await Promise.all(jobs))
      expect(result).toMatchObject({ code: 'timeout' });
    await expect(deadline.run(async () => 1)).rejects.toMatchObject({
      code: 'capacity',
    });
    expect(connect).toHaveBeenCalledTimes(4);
    pending.resolve(client as unknown as PoolClient);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.query).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(4);
    await expect(deadline.run(async () => 7)).resolves.toBe(7);
  });
  it('destroys an expired transaction, rejects stale continuations and does not commit after the deadline', async () => {
    vi.useFakeTimers();
    const { deadline, client } = fixture();
    const pending = deferred<void>();
    const task = deadline
      .run(async (_db, ensureOpen) => {
        await pending.promise;
        ensureOpen();
      })
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await task).toMatchObject({ code: 'timeout' });
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    pending.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.query.mock.calls.some(([value]) => value === 'COMMIT')).toBe(
      false,
    );
    expect(client.release).toHaveBeenCalledTimes(1);
  });
  it('checks wall time even when synchronous work has prevented the timer from firing', async () => {
    vi.useFakeTimers();
    const { deadline, client } = fixture();
    await expect(
      deadline.run(async (_db, ensureOpen) => {
        vi.setSystemTime(Date.now() + 10_001);
        ensureOpen();
      }),
    ).rejects.toMatchObject({ code: 'timeout' });
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.query.mock.calls.some(([value]) => value === 'COMMIT')).toBe(
      false,
    );
  });
  it('discards failed connections and preserves caller authorization errors', async () => {
    const { deadline, client } = fixture();
    const denied = new Error('authorization denied');
    await expect(
      deadline.run(async () => {
        throw denied;
      }),
    ).rejects.toBe(denied);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.query.mock.calls.some(([value]) => value === 'COMMIT')).toBe(
      false,
    );
  });
});
