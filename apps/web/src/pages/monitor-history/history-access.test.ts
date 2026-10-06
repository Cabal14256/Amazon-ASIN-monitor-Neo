import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/http';
import { createHistoryReadAccess } from './history-access';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('shared monitor history read authority', () => {
  it('refetches both disabled observers after denied data is removed from the cache', async () => {
    const client = new QueryClient();
    const access = createHistoryReadAccess();
    const list = vi.fn(async () => 'old history');
    const intervals = vi.fn(async () => 'old intervals');
    const observers = [list, intervals].map(
      (load, index) =>
        new QueryObserver(client, {
          queryKey: ['monitor-history', index],
          queryFn: ({ signal }) => access.read(load, signal),
          enabled: false,
          retry: false,
        }),
    );
    const unsubscribe = observers.map((observer) =>
      observer.subscribe(() => {}),
    );
    const reread = observers.map((observer) => async () => {
      const result = await observer.refetch({ throwOnError: true });
      if (!result.isSuccess) throw result.error;
      return result.data;
    });
    try {
      await Promise.all(reread.map((read) => read()));
      intervals.mockRejectedValueOnce(new ApiError('HTTP', 'Forbidden', 403));
      await expect(reread[1]()).rejects.toMatchObject({ status: 403 });
      await client.cancelQueries({ queryKey: ['monitor-history'] });
      client.removeQueries({ queryKey: ['monitor-history'] });
      expect(client.getQueriesData({ queryKey: ['monitor-history'] })).toEqual(
        [],
      );
      list.mockResolvedValue('new history');
      intervals.mockResolvedValue('new intervals');
      expect(await access.recover(reread)).toBe(true);
      expect(
        observers.map((observer) => observer.getCurrentResult().data),
      ).toEqual(['new history', 'new intervals']);
      expect(access.getSnapshot().denial).toBeNull();
    } finally {
      unsubscribe.forEach((stop) => stop());
      client.clear();
    }
  });
  it.each(['list', 'status-intervals', 'detail'])(
    'keeps every cached view hidden after a %s refusal and later failures',
    async (deniedSource) => {
      const client = new QueryClient();
      const access = createHistoryReadAccess();
      const fetch = (source: string, load: () => Promise<string>) =>
        client.fetchQuery({
          queryKey: ['monitor-history', source],
          queryFn: ({ signal }) => access.read(load, signal),
          retry: false,
          staleTime: 0,
        });
      try {
        for (const source of ['list', 'status-intervals', 'detail'])
          await fetch(source, async () => `cached ${source}`);
        const denied = new ApiError('HTTP', 'Forbidden', 403);
        await expect(
          fetch(deniedSource, async () => {
            throw denied;
          }),
        ).rejects.toBe(denied);
        expect(access.getSnapshot().denial).toBe(denied);
        // TanStack deliberately retains old data on refetch failure. The shared
        // refusal must stay authoritative even after query.error becomes 500.
        expect(client.getQueryData(['monitor-history', deniedSource])).toBe(
          `cached ${deniedSource}`,
        );
        await expect(
          fetch(deniedSource, async () => {
            throw new ApiError('HTTP', 'Unavailable', 500);
          }),
        ).rejects.toMatchObject({ status: 500 });
        await fetch('list', async () => 'background success');
        expect(access.getSnapshot().denial).toBe(denied);
        expect(
          await access.recover([
            () => fetch('list', async () => 'fresh history'),
            () =>
              fetch('status-intervals', async () => {
                throw new ApiError('HTTP', 'Unavailable', 500);
              }),
          ]),
        ).toBe(false);
        expect(access.getSnapshot()).toMatchObject({
          denial: denied,
          recovering: false,
          recoveryFailed: true,
        });
        expect(
          await access.recover([
            () => fetch('list', async () => 'fresh history'),
            () => fetch('status-intervals', async () => 'fresh intervals'),
          ]),
        ).toBe(true);
        expect(access.getSnapshot()).toEqual({
          denial: null,
          recovering: false,
          recoveryFailed: false,
        });
      } finally {
        client.clear();
      }
    },
  );

  it('ignores a late successful read that began before a refusal', async () => {
    const access = createHistoryReadAccess();
    const pending = deferred<string>();
    const oldRead = access.read(() => pending.promise);
    await expect(
      access.read(async () => {
        throw new ApiError('HTTP', 'Forbidden', 403);
      }),
    ).rejects.toMatchObject({ status: 403 });
    pending.resolve('old intervals');
    await oldRead;
    expect(access.getSnapshot().denial?.status).toBe(403);
  });

  it('does not clear a newer denial during explicit recovery or allow overlapping retries', async () => {
    const access = createHistoryReadAccess();
    await expect(
      access.read(async () => {
        throw new ApiError('HTTP', 'Forbidden', 403);
      }),
    ).rejects.toMatchObject({ status: 403 });
    const pending = deferred<string>();
    const retry = access.recover([() => access.read(() => pending.promise)]);
    expect(await access.recover([async () => 'overlapping'])).toBe(false);
    const newer = new ApiError('AUTH', 'Expired', 401);
    await expect(
      access.read(async () => {
        throw newer;
      }),
    ).rejects.toBe(newer);
    pending.resolve('late success');
    expect(await retry).toBe(false);
    expect(access.getSnapshot().denial).toBe(newer);
  });

  it('publishes envelope refusals but ignores an already cancelled request', async () => {
    const access = createHistoryReadAccess();
    const listener = vi.fn();
    const unsubscribe = access.subscribe(listener);
    const cancelled = new AbortController();
    cancelled.abort();
    const denied = new ApiError('BUSINESS', 'Forbidden', 200, 403);
    await expect(
      access.read(async () => {
        throw denied;
      }, cancelled.signal),
    ).rejects.toBe(denied);
    expect(access.getSnapshot().denial).toBeNull();
    await expect(
      access.read(async () => {
        throw denied;
      }),
    ).rejects.toBe(denied);
    expect(access.getSnapshot().denial).toBe(denied);
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });
});
