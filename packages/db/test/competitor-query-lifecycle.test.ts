import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PgCompetitorQueryRepository } from '../src/repositories/competitor-query-repository';

describe('competitor query / paired connection ownership', () => {
  const client = (name: string) =>
    Object.assign(new EventEmitter(), {
      query: vi.fn(
        async (
          input: string | { text: string },
        ): Promise<{ rows: Record<string, unknown>[] }> => {
          const text = typeof input === 'string' ? input : input.text;
          return { rows: text.includes('current_database') ? [{ name }] : [] };
        },
      ),
      release: vi.fn(),
    });
  let p: ReturnType<typeof client>, c: ReturnType<typeof client>;
  let primary: { connect: ReturnType<typeof vi.fn> },
    competitor: { connect: ReturnType<typeof vi.fn> },
    reader: PgCompetitorQueryRepository;
  beforeEach(() => {
    vi.useFakeTimers();
    p = client('primary');
    c = client('competitor');
    primary = { connect: vi.fn(async () => p as unknown as PoolClient) };
    competitor = { connect: vi.fn(async () => c as unknown as PoolClient) };
    reader = new PgCompetitorQueryRepository(
      primary as unknown as Pool,
      competitor as unknown as Pool,
    );
  });
  afterEach(() => {
    reader.close();
    vi.useRealTimers();
  });
  it('commits the competitor snapshot before releasing the primary authorization transaction', async () => {
    const order: string[] = [];
    for (const [name, value] of [
      ['primary', p],
      ['competitor', c],
    ] as const) {
      const original = value.query.getMockImplementation()!;
      value.query.mockImplementation(async (input) => {
        const text = typeof input === 'string' ? input : input.text;
        order.push(`${name}:${text}`);
        if (name === 'competitor' && text === 'COMMIT')
          expect(p.release).not.toHaveBeenCalled();
        if (text.includes('WITH selected'))
          return {
            rows: [{ groups: [], asins: [], total: '0', total_asins: '0' }],
          };
        return original(input);
      });
    }
    expect(
      await reader.read((unit) => unit.list({ current: 1, pageSize: 10 })),
    ).toEqual({ groups: [], asins: [], total: 0, totalASINs: 0 });
    expect(order.filter((value) => value.endsWith(':COMMIT'))).toEqual([
      'competitor:COMMIT',
      'primary:COMMIT',
    ]);
    expect(p.release).toHaveBeenCalledExactlyOnceWith(false);
    expect(c.release).toHaveBeenCalledExactlyOnceWith(false);
    expect(reader.getDiagnostics().pendingReads).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not acquire the competitor database when authorization rejects', async () => {
    const denied = new Error('authorization denied');
    await expect(
      reader.read(async () => {
        throw denied;
      }),
    ).rejects.toBe(denied);
    expect(competitor.connect).not.toHaveBeenCalled();
    expect(p.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(reader.getDiagnostics().pendingReads).toBe(0);
  });
  it('destroys both transactions on a competitor read failure and never returns a partial snapshot', async () => {
    c.query.mockRejectedValueOnce(new Error('synthetic failure'));
    await expect(reader.read((unit) => unit.detail('g'))).rejects.toThrow(
      'synthetic failure',
    );
    expect(p.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(c.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(p.query).not.toHaveBeenCalledWith('COMMIT');
  });
  it('rejects two pool objects connected to the same physical database', async () => {
    c.query.mockImplementation(async () => ({ rows: [{ name: 'primary' }] }));
    await expect(reader.read((unit) => unit.detail('g'))).rejects.toMatchObject(
      { code: 'dependency' },
    );
    expect(c.query.mock.calls).toHaveLength(3);
    expect(p.release).toHaveBeenCalledWith(true);
    expect(c.release).toHaveBeenCalledWith(true);
  });
  it('retains a late competitor acquisition slot after cancellation and releases its client before SQL', async () => {
    let finish!: (value: PoolClient) => void;
    competitor.connect.mockImplementation(
      () =>
        new Promise<PoolClient>((resolve) => {
          finish = resolve;
        }),
    );
    const abort = new AbortController();
    const task = reader.read((unit) => unit.detail('g'), abort.signal);
    const rejected = expect(task).rejects.toMatchObject({ code: 'cancelled' });
    await vi.advanceTimersByTimeAsync(0);
    expect(competitor.connect).toHaveBeenCalledTimes(1);
    abort.abort('private-reason');
    await rejected;
    expect(p.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(reader.getDiagnostics().pendingReads).toBe(1);
    finish(c as unknown as PoolClient);
    await vi.advanceTimersByTimeAsync(0);
    expect(c.query).not.toHaveBeenCalled();
    expect(c.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(reader.getDiagnostics().pendingReads).toBe(0);
  });
  it('bounds pool waits even after the public timeout has returned', async () => {
    primary.connect.mockImplementation(() => new Promise<never>(() => {}));
    const tasks = Array.from({ length: 8 }, () =>
      reader.read(async () => true).catch((error) => error),
    );
    await expect(reader.read(async () => true)).rejects.toMatchObject({
      code: 'capacity',
    });
    await vi.advanceTimersByTimeAsync(4000);
    expect(await Promise.all(tasks)).toEqual(
      Array.from({ length: 8 }, () =>
        expect.objectContaining({ code: 'timeout' }),
      ),
    );
    expect(reader.getDiagnostics().pendingReads).toBe(8);
    await expect(reader.read(async () => true)).rejects.toMatchObject({
      code: 'capacity',
    });
    expect(primary.connect).toHaveBeenCalledTimes(8);
  });
  it('closes both borrowed clients and rejects subsequent work', async () => {
    let finish!: () => void;
    c.query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = () => resolve({ rows: [] });
        }),
    );
    const task = reader.read((unit) => unit.detail('g'));
    const rejected = expect(task).rejects.toMatchObject({ code: 'closed' });
    await vi.advanceTimersByTimeAsync(0);
    reader.close();
    await rejected;
    expect(p.release).toHaveBeenCalledExactlyOnceWith(true);
    expect(c.release).toHaveBeenCalledExactlyOnceWith(true);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(reader.getDiagnostics().pendingReads).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await expect(reader.read(async () => true)).rejects.toMatchObject({
      code: 'closed',
    });
  });
  it('does not acquire a connection for pre-cancelled work', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(
      reader.read(async () => true, abort.signal),
    ).rejects.toMatchObject({ code: 'cancelled' });
    expect(primary.connect).not.toHaveBeenCalled();
  });
});
