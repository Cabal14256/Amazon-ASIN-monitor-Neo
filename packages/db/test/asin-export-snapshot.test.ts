import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withAsinExportDatabaseTransaction } from '../src/repositories/asin-query-repository';

afterEach(() => vi.useRealTimers());

describe('bounded ASIN export snapshot', () => {
  it('allows a slow artifact sink beyond 65 seconds while retaining the SQL statement deadline', async () => {
    vi.useFakeTimers();
    const client = Object.assign(new EventEmitter(), {
      query: vi.fn(async () => ({ rows: [] })),
      release: vi.fn(),
    });
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let resume!: () => void;
    const drained = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const result = withAsinExportDatabaseTransaction(
      pool,
      async (_db, ensureOpen) => {
        enter();
        await drained;
        ensureOpen();
        return 'snapshot-complete';
      },
    );
    const outcome = result.then(
      (value) => value,
      (error: unknown) => error,
    );
    await entered;
    await vi.advanceTimersByTimeAsync(70_000);
    expect(client.release).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith(
      'SET LOCAL statement_timeout = 60000',
    );
    resume();
    expect(await outcome).toBe('snapshot-complete');
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalledExactlyOnceWith();
  });
  it.each(['deadline', 'cancel'] as const)(
    'destroys the connection on %s and cannot commit a late callback',
    async (reason) => {
      vi.useFakeTimers();
      const client = Object.assign(new EventEmitter(), {
        query: vi.fn(async () => ({ rows: [] })),
        release: vi.fn(),
      });
      const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
      const controller = new AbortController();
      let enter!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      let finish!: () => void;
      const delayed = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let ensureOpen!: () => void;
      const operation = withAsinExportDatabaseTransaction(
        pool,
        async (_db, assertOpen) => {
          ensureOpen = assertOpen;
          enter();
          await delayed;
          return 'late-result';
        },
        controller.signal,
      );
      const rejected = expect(operation).rejects.toThrow(
        reason === 'deadline'
          ? 'ASIN_EXPORT_QUERY_TIMEOUT'
          : 'ASIN_EXPORT_QUERY_CANCELLED',
      );
      await entered;
      expect(client.query).toHaveBeenCalledWith(
        'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      );
      expect(client.query).toHaveBeenCalledWith(
        'SET LOCAL statement_timeout = 60000',
      );
      expect(client.query.mock.calls.flat().join(' ')).not.toContain(
        'pg_advisory',
      );
      if (reason === 'deadline') await vi.advanceTimersByTimeAsync(30 * 60_000);
      else controller.abort();
      await rejected;
      expect(client.release).toHaveBeenCalledExactlyOnceWith(true);
      expect(ensureOpen).toThrow();
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(client.query).not.toHaveBeenCalledWith('COMMIT');
      expect(client.release).toHaveBeenCalledOnce();
    },
  );
});
