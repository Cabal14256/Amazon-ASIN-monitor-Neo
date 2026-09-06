import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditQueryDeadline } from '../src/repositories/audit-query-deadline';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function clientFixture() {
  return Object.assign(new EventEmitter(), {
    query: vi.fn(async (_query: string) => ({ rows: [] })),
    release: vi.fn(),
  });
}
afterEach(() => vi.useRealTimers());
describe('bounded read-only audit transactions', () => {
  it('uses one consistent read-only transaction and returns the connection', async () => {
    const client = clientFixture();
    const read = new AuditQueryDeadline({
      connect: async () => client,
    } as unknown as Pool);
    await expect(read.run(async () => 42)).resolves.toBe(42);
    expect(client.query.mock.calls.map((call) => call[0])).toEqual([
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'SET LOCAL statement_timeout = 4000',
      'COMMIT',
    ]);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
    expect(client.listenerCount('error')).toBe(0);
  });
  it('retains eight acquisition slots through timeout until late clients are released', async () => {
    vi.useFakeTimers();
    const pending = Array.from({ length: 8 }, () => deferred<PoolClient>());
    const connect = vi.fn().mockImplementation(() => pending.shift()!.promise);
    const captures = [...pending];
    const read = new AuditQueryDeadline({ connect } as unknown as Pool);
    const operations = Array.from({ length: 8 }, () =>
      read.run(async () => 'unused').catch((error) => error),
    );
    await expect(read.run(async () => '')).rejects.toMatchObject({
      reason: 'capacity',
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(
      (await Promise.all(operations)).every(
        (error) => error.reason === 'timeout',
      ),
    ).toBe(true);
    await expect(read.run(async () => '')).rejects.toMatchObject({
      reason: 'capacity',
    });
    for (const capture of captures) {
      const client = clientFixture();
      capture.resolve(client as unknown as PoolClient);
      await vi.advanceTimersByTimeAsync(0);
      expect(client.query).not.toHaveBeenCalled();
      expect(client.release).toHaveBeenCalledOnce();
    }
    await vi.advanceTimersByTimeAsync(0);
    const recovered = clientFixture();
    connect.mockResolvedValue(recovered);
    await expect(read.run(async () => 'recovered')).resolves.toBe('recovered');
  });
  it('destroys a timed-out client and prevents follow-up work or late commit', async () => {
    vi.useFakeTimers();
    const client = clientFixture();
    const result = deferred<void>();
    const followUp = vi.fn();
    const read = new AuditQueryDeadline({
      connect: async () => client,
    } as unknown as Pool);
    const pending = read
      .run(async (_db, ensureOpen) => {
        await result.promise;
        ensureOpen();
        followUp();
      })
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toMatchObject({ reason: 'timeout' });
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    result.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(followUp).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalledWith('COMMIT');
  });
  it('sanitizes SQL and connection errors, destroys the transaction, and frees admission', async () => {
    const client = clientFixture();
    client.query.mockRejectedValueOnce(
      new Error('SELECT secret fixture-secret'),
    );
    const read = new AuditQueryDeadline({
      connect: async () => client,
    } as unknown as Pool);
    const error = await read.run(async () => 1).catch((failure) => failure);
    expect(error).toMatchObject({
      reason: 'unavailable',
      message: 'Audit query unavailable',
    });
    expect(error.cause).toBeUndefined();
    expect(client.release).toHaveBeenCalledWith(true);
    const pending = deferred<void>();
    const later = read
      .run(async () => {
        await pending.promise;
        return 2;
      })
      .catch((failure) => failure);
    await vi.waitFor(() => expect(client.listenerCount('error')).toBe(1));
    client.emit('error', new Error('fixture connection failure'));
    expect(await later).toMatchObject({ reason: 'unavailable' });
    pending.resolve();
  });
  it('does not hang if a broken pool throws while releasing a connection', async () => {
    const client = clientFixture();
    client.release.mockImplementation(() => {
      throw new Error('fixture release failure');
    });
    const read = new AuditQueryDeadline({
      connect: async () => client,
    } as unknown as Pool);
    await expect(read.run(async () => 1)).rejects.toMatchObject({
      reason: 'unavailable',
    });
  });
  it.each([{ code: '57014' }, { cause: { code: '57014' } }])(
    'classifies a PostgreSQL cancellation as a timeout',
    async (error) => {
      const client = clientFixture();
      const read = new AuditQueryDeadline({
        connect: async () => client,
      } as unknown as Pool);
      await expect(
        read.run(async () => {
          throw error;
        }),
      ).rejects.toMatchObject({ reason: 'timeout' });
      expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    },
  );
});
