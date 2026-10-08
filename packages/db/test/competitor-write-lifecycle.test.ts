import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogOperationIdentity } from '../src/domain/catalog-operation';
import { withCatalogOperationExecution } from '../src/repositories/catalog-operation-execution';
import type { PgCatalogOperationRepository } from '../src/repositories/catalog-operation-repository';
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
  it('retains its durable pin after an outer timeout until the competitor COMMIT actually settles', async () => {
    const identity: CatalogOperationIdentity = {
      ownerId: 'owner',
      domain: 'competitor',
      kind: 'import',
      generation: '1',
      operationId: '00000000-0000-4000-8000-000000000224',
    };
    const pin = { identity, pinId: '00000000-0000-4000-8000-000000000225' };
    const repository = {
      beginPin: vi.fn(async () => pin),
      assertPin: vi.fn(async () => undefined),
      finishPin: vi.fn(async () => undefined),
    };
    let ack!: () => void;
    const original = c.query.getMockImplementation()!;
    c.query.mockImplementation(async (text) =>
      text === 'COMMIT'
        ? new Promise((resolve) => {
            ack = () => resolve({ rows: [] });
          })
        : original(text),
    );
    const work = withCatalogOperationExecution(
      repository as unknown as PgCatalogOperationRepository,
      identity,
      () =>
        transactions.run(false, async ({ database }) => {
          await database();
          return 'done';
        }),
    );
    const rejected = expect(work).rejects.toMatchObject({
      code: 'commit-uncertain',
    });
    await vi.advanceTimersByTimeAsync(4000);
    await rejected;
    expect(repository.assertPin).toHaveBeenCalledTimes(1);
    expect(repository.finishPin).not.toHaveBeenCalled();
    expect(transactions.getDiagnostics().pendingOperations).toBe(1);
    ack();
    await vi.advanceTimersByTimeAsync(0);
    expect(repository.finishPin).toHaveBeenCalledExactlyOnceWith(
      pin,
      'uncertain',
    );
    expect(transactions.getDiagnostics().pendingOperations).toBe(0);
    expect(p.query).not.toHaveBeenCalledWith('COMMIT');
  });
  it('settles a fenced pin only after both actual database COMMITs and connection releases', async () => {
    const identity: CatalogOperationIdentity = {
      ownerId: 'owner',
      domain: 'competitor',
      kind: 'write',
      generation: '1',
      operationId: '00000000-0000-4000-8000-000000000224',
    };
    const pin = { identity, pinId: '00000000-0000-4000-8000-000000000225' };
    const repository = {
      beginPin: vi.fn(async () => pin),
      assertPin: vi.fn(async () => undefined),
      finishPin: vi.fn(async (_pin, outcome) => {
        expect(outcome).toBe('committed');
        expect(p.query).toHaveBeenCalledWith('COMMIT');
        expect(c.query).toHaveBeenCalledWith('COMMIT');
        expect(p.release).toHaveBeenCalledExactlyOnceWith(false);
        expect(c.release).toHaveBeenCalledExactlyOnceWith(false);
      }),
    };
    await withCatalogOperationExecution(
      repository as unknown as PgCatalogOperationRepository,
      identity,
      () =>
        transactions.run(false, async ({ database }) => {
          await database();
          return 'done';
        }),
    );
    expect(repository.finishPin).toHaveBeenCalledTimes(1);
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
  it.each([0, -1, 1.5, 17, Infinity, NaN])(
    'rejects invalid admission capacity %s',
    (maximum) => {
      expect(
        () => new PgCompetitorTransactions({} as Pool, {} as Pool, maximum),
      ).toThrow('dependency');
    },
  );
  it.each([undefined, 1, 16])(
    'bounds configured capacity %s and retains late acquisition ownership',
    async (maximum) => {
      const count = maximum ?? 8;
      const releases: (() => void)[] = [];
      const clients = Array.from({ length: count }, () => client('primary'));
      const primary = {
        connect: vi.fn(
          () =>
            new Promise<PoolClient>((resolve) => {
              const index = releases.length;
              releases.push(() =>
                resolve(clients[index] as unknown as PoolClient),
              );
            }),
        ),
      };
      const competitor = { connect: vi.fn() };
      transactions = new PgCompetitorTransactions(
        primary as unknown as Pool,
        competitor as unknown as Pool,
        maximum,
      );
      const pending = Array.from({ length: count }, () =>
        transactions.run(false, async () => undefined),
      );
      const settled = Promise.allSettled(pending);
      expect(transactions.getDiagnostics().pendingOperations).toBe(count);
      await expect(
        transactions.run(false, async () => undefined),
      ).rejects.toMatchObject({ code: 'capacity' });
      transactions.close();
      expect(
        (await settled).every((result) => result.status === 'rejected'),
      ).toBe(true);
      expect(transactions.getDiagnostics().pendingOperations).toBe(count);
      releases.forEach((resolve) => resolve());
      await vi.advanceTimersByTimeAsync(0);
      expect(transactions.getDiagnostics().pendingOperations).toBe(0);
      clients.forEach((value) =>
        expect(value.release).toHaveBeenCalledExactlyOnceWith(true),
      );
      expect(competitor.connect).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
