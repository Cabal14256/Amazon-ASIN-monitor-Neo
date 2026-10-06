import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PgAccountRepository } from '../src/repositories/account-repository';
import {
  AuthQueryTimeoutError,
  withAuthDatabaseDeadline,
} from '../src/repositories/bounded-auth-repository';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function fixture() {
  const client = Object.assign(new EventEmitter(), {
    query: vi.fn().mockResolvedValue({ rows: [] }),
    release: vi.fn(),
  });
  const pool = {
    connect: vi.fn().mockResolvedValue(client),
  } as unknown as Pool;
  return { pool, client };
}
describe('bounded PostgreSQL authentication operations', () => {
  it('settles only after actual COMMIT and returns its client before borrowing a pin-settlement connection', async () => {
    const { pool, client } = fixture();
    const settled = vi.fn(async (outcome) => {
      expect(outcome).toBe('committed');
      expect(client.query).toHaveBeenCalledWith('COMMIT');
      expect(client.release).toHaveBeenCalledExactlyOnceWith();
    });
    await withAuthDatabaseDeadline(pool, async () => 'ok', settled);
    expect(settled).toHaveBeenCalledTimes(1);
  });
  it('keeps an in-flight COMMIT pin pending past the outer deadline, then records uncertainty only after it settles', async () => {
    vi.useFakeTimers();
    const { pool, client } = fixture();
    let commitAck!: () => void;
    const original = client.query.getMockImplementation()!;
    client.query.mockImplementation(async (...args) =>
      args[0] === 'COMMIT'
        ? new Promise((resolve) => {
            commitAck = () => resolve({ rows: [] });
          })
        : original(...args),
    );
    const settled = vi.fn(async () => undefined);
    const task = withAuthDatabaseDeadline(pool, async () => 'ok', settled);
    const rejected = expect(task).rejects.toBeInstanceOf(AuthQueryTimeoutError);
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
    expect(settled).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    commitAck();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledExactlyOnceWith('uncertain');
    expect(client.query).not.toHaveBeenCalledWith('ROLLBACK');
  });
  it('requires a real ROLLBACK acknowledgement for definite business failure', async () => {
    const { pool, client } = fixture();
    const settled = vi.fn(async () => undefined);
    await expect(
      withAuthDatabaseDeadline(
        pool,
        async () => {
          throw new Error('known failure');
        },
        settled,
      ),
    ).rejects.toThrow('known failure');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(settled).toHaveBeenCalledExactlyOnceWith('rolled-back');
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
  });
  it('prevents a late password hash from issuing any account writes after the transaction deadline', async () => {
    vi.useFakeTimers();
    const { pool, client } = fixture();
    let release!: () => void;
    const hashWork = new Promise<void>((resolve) => {
      release = resolve;
    });
    const lateWrite = vi.fn();
    const task = new PgAccountRepository(pool).transaction(async (unit) => {
      await hashWork;
      try {
        await unit.savePreviousPassword('fixture', 'fixture-hash', new Date());
      } catch (error) {
        lateWrite(error);
        throw error;
      }
    });
    const rejected = expect(task).rejects.toBeInstanceOf(AuthQueryTimeoutError);
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(lateWrite).toHaveBeenCalledWith(expect.any(AuthQueryTimeoutError));
    expect(client.query.mock.calls.map(([query]) => query)).toEqual([
      'BEGIN',
      'SET LOCAL statement_timeout = 1500',
    ]);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });
  it('uses a local statement timeout and returns a committed connection', async () => {
    const { pool, client } = fixture();
    await expect(
      withAuthDatabaseDeadline(pool, async () => 'ok'),
    ).resolves.toBe('ok');
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'SET LOCAL statement_timeout = 1500',
      'COMMIT',
    ]);
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
  });
  it('destroys the exclusive connection when a query fails', async () => {
    const { pool, client } = fixture();
    await expect(
      withAuthDatabaseDeadline(pool, async () => {
        throw new Error('fixture failure');
      }),
    ).rejects.toThrow('fixture failure');
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.query).not.toHaveBeenCalledWith('COMMIT');
  });

  it('handles an acquired-client error without an unhandled EventEmitter error', async () => {
    const { pool, client } = fixture();
    const task = withAuthDatabaseDeadline(
      pool,
      () => new Promise<never>(() => undefined),
    );
    const error = new Error('fixture connection failed');
    const rejected = expect(task).rejects.toBe(error);
    await Promise.resolve();
    expect(() => client.emit('error', error)).not.toThrow();
    await rejected;
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(client.listenerCount('error')).toBe(0);
  });
  it('settles a hung query at the deadline, destroys its connection and ignores late completion', async () => {
    vi.useFakeTimers();
    const { pool, client } = fixture();
    let release!: (value: string) => void;
    const task = withAuthDatabaseDeadline(
      pool,
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const rejected = expect(task).rejects.toBeInstanceOf(AuthQueryTimeoutError);
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
    release('late');
    await Promise.resolve();
    expect(client.query).not.toHaveBeenCalledWith('COMMIT');
  });
  it('does not start a business query when BEGIN completes after timeout', async () => {
    vi.useFakeTimers();
    const { pool, client } = fixture();
    let release!: () => void;
    client.query.mockReturnValueOnce(
      new Promise((resolve) => {
        release = () => resolve({ rows: [] });
      }),
    );
    const operation = vi.fn().mockResolvedValue('ok');
    const task = withAuthDatabaseDeadline(pool, operation);
    const rejected = expect(task).rejects.toBeInstanceOf(AuthQueryTimeoutError);
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
    release();
    await Promise.resolve();
    expect(operation).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
  });
});
