import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgCompetitorTransactions } from '../src/repositories/competitor-transactions';

describe('paired competitor writes / commit outcome and authorization lifetime', () => {
  const client = (name: string) =>
    Object.assign(new EventEmitter(), {
      query: vi.fn(
        async (text: string): Promise<{ rows: { name: string }[] }> => ({
          rows: text.includes('current_database') ? [{ name }] : [],
        }),
      ),
      release: vi.fn(),
    });
  let p: ReturnType<typeof client>,
    c: ReturnType<typeof client>,
    transactions: PgCompetitorTransactions;
  beforeEach(() => {
    vi.useFakeTimers();
    p = client('primary');
    c = client('competitor');
    transactions = new PgCompetitorTransactions(
      {
        connect: vi.fn(async () => p as unknown as PoolClient),
      } as unknown as Pool,
      {
        connect: vi.fn(async () => c as unknown as PoolClient),
      } as unknown as Pool,
    );
  });
  afterEach(() => {
    transactions.close();
    vi.useRealTimers();
  });
  it('uses a writable competitor transaction and holds primary authorization through commit', async () => {
    const original = c.query.getMockImplementation()!;
    c.query.mockImplementation(async (text) => {
      if (text === 'COMMIT') expect(p.release).not.toHaveBeenCalled();
      return original(text);
    });
    expect(
      await transactions.run(false, async ({ database }) => {
        await database();
        return 'done';
      }),
    ).toBe('done');
    expect(c.query).toHaveBeenCalledWith('BEGIN');
    expect(c.query).not.toHaveBeenCalledWith('BEGIN READ ONLY');
    expect(p.release).toHaveBeenCalledExactlyOnceWith(false);
    expect(c.release).toHaveBeenCalledExactlyOnceWith(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['primary', 'competitor'])(
    'reports %s commit acknowledgement failure as uncertain, without promising rollback',
    async (which) => {
      const value = which === 'primary' ? p : c;
      const original = value.query.getMockImplementation()!;
      value.query.mockImplementation(async (text) => {
        if (text === 'COMMIT') throw new Error('private-driver-value');
        return original(text);
      });
      await expect(
        transactions.run(false, async ({ database }) => {
          await database();
          return true;
        }),
      ).rejects.toMatchObject({
        code: 'commit-uncertain',
        message: 'Competitor transaction commit-uncertain',
      });
      expect(p.release).toHaveBeenCalledExactlyOnceWith(true);
      expect(c.release).toHaveBeenCalledExactlyOnceWith(true);
      expect(transactions.getDiagnostics().pendingOperations).toBe(0);
    },
  );
  it.each(['cancel', 'close', 'timeout', 'connection-error'])(
    'keeps a pending COMMIT outcome uncertain on %s',
    async (which) => {
      let finish!: () => void;
      const original = c.query.getMockImplementation()!;
      c.query.mockImplementation(async (text) =>
        text === 'COMMIT'
          ? new Promise((resolve) => {
              finish = () => resolve({ rows: [] });
            })
          : original(text),
      );
      const abort = new AbortController();
      const pending = transactions.run(
        false,
        async ({ database }) => {
          await database();
          return true;
        },
        abort.signal,
      );
      const rejected = expect(pending).rejects.toMatchObject({
        code: 'commit-uncertain',
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(finish).toBeTypeOf('function');
      if (which === 'cancel') abort.abort('private-reason');
      if (which === 'close') transactions.close();
      if (which === 'timeout') await vi.advanceTimersByTimeAsync(4000);
      if (which === 'connection-error')
        p.emit('error', new Error('private-connection'));
      await rejected;
      expect(p.release).toHaveBeenCalledExactlyOnceWith(true);
      expect(c.release).toHaveBeenCalledExactlyOnceWith(true);
      expect(p.query).not.toHaveBeenCalledWith('COMMIT');
      expect(transactions.getDiagnostics().pendingOperations).toBe(1);
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(transactions.getDiagnostics().pendingOperations).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it('rejects borrowed database access after the owning operation finishes', async () => {
    let getDatabase!: () => unknown;
    await transactions.run(false, async ({ database }) => {
      getDatabase = database;
      await database();
    });
    expect(() => getDatabase()).toThrow('Competitor transaction closed');
    expect(c.query).toHaveBeenCalledTimes(4);
  });
  it('does not start a competitor commit after losing the primary authorization connection', async () => {
    await expect(
      transactions.run(false, async ({ database, ensureOpen }) => {
        await database();
        p.emit('error', new Error('private-connection'));
        ensureOpen();
      }),
    ).rejects.toMatchObject({ code: 'dependency' });
    expect(c.query).not.toHaveBeenCalledWith('COMMIT');
    expect(p.release).toHaveBeenCalledWith(true);
    expect(c.release).toHaveBeenCalledWith(true);
  });
});
