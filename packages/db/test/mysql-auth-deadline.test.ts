import type { Pool } from 'mysql2/promise';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LegacyMysqlAuthRepository } from '../src/repositories/legacy-mysql-auth-repository';

const config = {
  host: 'localhost',
  port: 3306,
  user: 'fixture',
  password: 'unused',
  database: 'fixture',
  connectionLimit: 10,
  connectTimeoutMs: 600_000,
  queryTimeoutMs: 600_000,
};
function fixture() {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn().mockResolvedValue([[], []]),
    release: vi.fn(),
    destroy: vi.fn(),
  });
  const pool = { getConnection: vi.fn().mockResolvedValue(client) };
  return {
    client,
    pool,
    repository: new LegacyMysqlAuthRepository(config, pool as unknown as Pool),
  };
}
afterEach(() => vi.useRealTimers());

describe('Legacy MySQL auth hard deadline', () => {
  it('caps query timeout independently of the legacy ten-minute default', async () => {
    const { client, repository } = fixture();
    await repository.findSessionById('missing');
    expect(client.query).toHaveBeenCalledWith(
      expect.objectContaining({ timeout: 2_000, values: ['missing'] }),
    );
    expect(client.release).toHaveBeenCalledOnce();
    expect(client.destroy).not.toHaveBeenCalled();
    expect(client.listenerCount('error')).toBe(0);
  });
  it('destroys a stalled connection and ignores a late result', async () => {
    vi.useFakeTimers();
    const { client, repository } = fixture();
    let finish!: (value: unknown) => void;
    client.query.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const result = repository.findSessionById('stalled');
    const rejected = expect(result).rejects.toMatchObject({
      code: 'AUTH_QUERY_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;
    expect(client.destroy).toHaveBeenCalledOnce();
    finish([[], []]);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.release).not.toHaveBeenCalled();
    expect(client.destroy).toHaveBeenCalledOnce();
  });
  it('destroys a late acquisition without starting SQL', async () => {
    vi.useFakeTimers();
    const { pool, client, repository } = fixture();
    let acquire!: (value: unknown) => void;
    pool.getConnection.mockReturnValueOnce(
      new Promise((resolve) => {
        acquire = resolve;
      }),
    );
    const result = repository.findSessionById('queued');
    const rejected = expect(result).rejects.toMatchObject({
      code: 'AUTH_QUERY_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(2_000);
    await rejected;
    acquire(client);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(client.query).not.toHaveBeenCalled();
  });
  it('destroys failed writes without leaking connection listeners', async () => {
    const { client, repository } = fixture();
    const failure = Object.assign(new Error('fixture failure'), {
      code: 'ECONNRESET',
    });
    client.query.mockRejectedValueOnce(failure);
    await expect(repository.touchSession('id')).rejects.toBe(failure);
    expect(client.destroy).toHaveBeenCalledOnce();
    expect(client.release).not.toHaveBeenCalled();
    expect(client.listenerCount('error')).toBe(0);
  });
});
