import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditRepository } from '../src/repositories/audit-repository';

const entry = { action: 'CREATE', resource: 'asin' };
const fixture = () => {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  });
  const pool = { connect: vi.fn().mockResolvedValue(client) };
  return {
    client,
    pool,
    repository: new AuditRepository(pool as unknown as Pool),
  };
};
afterEach(() => vi.useRealTimers());

describe('AuditRepository write deadline', () => {
  it.each(['resolve', 'reject'])(
    'retains actual acquisition slots after the public deadline until they %s',
    async (outcome) => {
      vi.useFakeTimers();
      const { pool, client, repository } = fixture();
      let acquire!: (client: PoolClient) => void;
      let fail!: (error: Error) => void;
      const acquisition = new Promise<PoolClient>((resolve, reject) => {
        acquire = resolve;
        fail = reject;
      });
      pool.connect.mockImplementation(() => acquisition);
      const writes = [repository.append(entry), repository.append(entry)].map(
        (write) => expect(write).rejects.toMatchObject({ code: 'ETIMEDOUT' }),
      );
      await vi.advanceTimersByTimeAsync(2_000);
      await Promise.all(writes);
      await expect(repository.append(entry)).rejects.toMatchObject({
        code: '53300',
      });
      expect(pool.connect).toHaveBeenCalledTimes(2);
      if (outcome === 'resolve') acquire(client as unknown as PoolClient);
      else fail(new Error('fixture acquisition failed'));
      await vi.advanceTimersByTimeAsync(0);
      expect(client.query).not.toHaveBeenCalled();
      expect(client.release).toHaveBeenCalledTimes(
        outcome === 'resolve' ? 2 : 0,
      );
      pool.connect.mockResolvedValue(client);
      await repository.append(entry);
      expect(pool.connect).toHaveBeenCalledTimes(3);
      expect(client.query).toHaveBeenCalledTimes(4);
    },
  );

  it('commits with a transaction-local SQL timeout and releases a healthy client', async () => {
    const { client, repository } = fixture();
    await repository.append(entry);
    expect(
      client.query.mock.calls.map(([query]) =>
        typeof query === 'string' ? query : query.text,
      ),
    ).toEqual([
      'BEGIN',
      'SET LOCAL statement_timeout = 1500',
      expect.stringContaining('insert into "audit_logs"'),
      'COMMIT',
    ]);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(false);
    expect(client.listenerCount('error')).toBe(0);
  });

  it.each(['BEGIN', 'INSERT'])(
    'destroys a stalled %s client and cannot start late work',
    async (stage) => {
      vi.useFakeTimers();
      const { client, repository } = fixture();
      let finish!: (value: unknown) => void;
      const pending = new Promise((resolve) => {
        finish = resolve;
      });
      if (stage === 'INSERT')
        client.query
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [] });
      client.query.mockImplementationOnce(() => pending);
      const write = repository.append(entry);
      const rejected = expect(write).rejects.toMatchObject({
        code: 'ETIMEDOUT',
      });
      await vi.advanceTimersByTimeAsync(2_000);
      await rejected;
      expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
      const calls = client.query.mock.calls.length;
      finish({ rows: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(client.query).toHaveBeenCalledTimes(calls);
      expect(client.release).toHaveBeenCalledOnce();
    },
  );

  it('releases late pool acquisition without executing a query', async () => {
    vi.useFakeTimers();
    const { pool, client, repository } = fixture();
    let acquire!: (client: PoolClient) => void;
    pool.connect.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acquire = resolve;
        }),
    );
    const write = repository.append(entry);
    const rejected = expect(write).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;
    acquire(client as unknown as PoolClient);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.query).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
  });

  it('destroys failed query connections without committing or leaking listeners', async () => {
    const { client, repository } = fixture();
    client.query.mockRejectedValueOnce(
      Object.assign(new Error('query failed'), { code: '42501' }),
    );
    await expect(repository.append(entry)).rejects.toMatchObject({
      code: '42501',
    });
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.listenerCount('error')).toBe(0);
  });

  it('handles an acquired connection error and observes the eventual query failure', async () => {
    const { client, repository } = fixture();
    let rejectQuery!: (error: Error) => void;
    client.query.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectQuery = reject;
        }),
    );
    const write = repository.append(entry);
    await vi.waitFor(() => expect(client.query).toHaveBeenCalled());
    const failure = Object.assign(new Error('connection lost'), {
      code: 'ECONNRESET',
    });
    client.emit('error', failure);
    await expect(write).rejects.toBe(failure);
    rejectQuery(failure);
    await Promise.resolve();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.listenerCount('error')).toBe(0);
  });
});
