import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deferred,
  FakeSocket,
  jsonResponse,
  sessionFixture,
} from '../lib/transport-fixtures';
import { createTransportRuntime } from '../services/runtime';
import { IdentityStore } from './identity';

const identity = {
  user: {
    id: 'fixture-one',
    username: 'fixture',
    status: 'ACTIVE',
    force_password_change: false,
  },
  permissions: ['asin:read'],
  roles: ['USER'],
  sessionId: 'fixture-session',
  mustChangePassword: false,
  passwordExpired: false,
};
const cleanups: (() => void)[] = [];
function setup() {
  const f = sessionFixture();
  const fetcher = vi.fn<typeof fetch>(async () =>
    jsonResponse({ success: true, data: identity }),
  );
  const sockets: FakeSocket[] = [];
  const socket = vi.fn(() => {
    const value = new FakeSocket();
    sockets.push(value);
    return value;
  });
  const runtime = createTransportRuntime({
    pageOrigin: 'https://app.test',
    fetch: fetcher,
    socket,
    session: f.store,
  });
  const store = new IdentityStore(runtime);
  const result = { ...f, runtime, store, fetcher, socket, sockets };
  cleanups.push(() => {
    store.stop();
    runtime.dispose();
  });
  return result;
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('server-verified application identity', () => {
  it('is inert until started, verifies even without hints and connects only after the response', async () => {
    const f = setup();
    const pending = deferred<Response>();
    f.fetcher.mockReturnValueOnce(pending.promise);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.runtime.session.hasSession()).toBe(false);
    f.store.start();
    expect(f.store.getSnapshot()).toEqual({ status: 'loading' });
    expect(f.socket).not.toHaveBeenCalled();
    pending.resolve(jsonResponse({ success: true, data: identity }));
    await f.store.refresh();
    expect(f.store.getSnapshot()).toEqual({
      status: 'authenticated',
      identity,
    });
    expect(f.socket).toHaveBeenCalledOnce();
    expect(f.runtime.session.hasSession()).toBe(false); // No token/hint fabricated from current-user.
  });
  it('shares in-flight verification across start and refresh calls', async () => {
    const f = setup();
    f.store.start();
    f.store.start();
    await Promise.all([f.store.refresh(), f.store.refresh()]);
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it('makes a route wait for replacement verification after a cross-tab session change', async () => {
    const f = setup();
    const oldResponse = deferred<Response>();
    const nextResponse = deferred<Response>();
    f.fetcher
      .mockReturnValueOnce(oldResponse.promise)
      .mockReturnValueOnce(nextResponse.promise);
    let finished = false;
    const verified = f.store.ensure().then((state) => {
      finished = true;
      return state;
    });
    f.runtime.refreshSession();
    oldResponse.resolve(jsonResponse({ success: false, errorCode: 401 }, 401));
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
    expect(finished).toBe(false);
    nextResponse.resolve(jsonResponse({ success: true, data: identity }));
    expect(await verified).toEqual({ status: 'authenticated', identity });
  });
  it.each([401, 403])(
    'treats a current-user %s as anonymous and clears all cached work',
    async (status) => {
      const f = setup();
      f.runtime.session.markAuthenticated();
      f.runtime.queryClient.setQueryData(['private'], 'old data');
      f.fetcher.mockResolvedValueOnce(
        jsonResponse({ success: false, errorCode: status }, status),
      );
      f.store.start();
      await f.store.refresh();
      expect(f.store.getSnapshot()).toEqual({ status: 'anonymous' });
      expect(f.runtime.session.hasSession()).toBe(false);
      expect(f.runtime.queryClient.getQueryData(['private'])).toBeUndefined();
      expect(f.socket).not.toHaveBeenCalled();
    },
  );
  it('keeps network failure unavailable even with a hint, and allows an explicit retry', async () => {
    const f = setup();
    f.runtime.session.markAuthenticated();
    f.fetcher.mockRejectedValueOnce(new Error('offline fixture'));
    f.store.start();
    await f.store.refresh();
    expect(f.store.getSnapshot()).toEqual({ status: 'error' });
    expect(f.socket).not.toHaveBeenCalled();
    await f.store.refresh();
    expect(f.store.getSnapshot().status).toBe('authenticated');
  });
  it.each([
    { success: true },
    { success: false, data: identity },
    { data: identity },
  ])('does not promote an incomplete or failed envelope: %j', async (body) => {
    const f = setup();
    f.fetcher.mockResolvedValueOnce(jsonResponse(body));
    f.store.start();
    await f.store.refresh();
    expect(f.store.getSnapshot()).toEqual({ status: 'error' });
    expect(f.socket).not.toHaveBeenCalled();
  });
  it('rejects an inactive identity even in a successful envelope', async () => {
    const f = setup();
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { ...identity, user: { ...identity.user, status: 'SUSPENDED' } },
      }),
    );
    f.store.start();
    await f.store.refresh();
    expect(f.store.getSnapshot()).toEqual({ status: 'anonymous' });
  });
  it('ignores late identity after logout/reset, even for a fetch that ignores cancellation', async () => {
    const f = setup();
    const pending = deferred<Response>();
    f.fetcher.mockReturnValueOnce(pending.promise);
    f.store.start();
    const wait = f.store.refresh();
    f.runtime.reset();
    await wait;
    pending.resolve(jsonResponse({ success: true, data: identity }));
    await Promise.resolve();
    await Promise.resolve();
    expect(f.store.getSnapshot()).toEqual({ status: 'anonymous' });
    expect(f.socket).not.toHaveBeenCalled();
    expect((f.fetcher.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(
      true,
    );
  });
  it('discards old user identity on cross-tab changes and reconnects only for the new verified user', async () => {
    const f = setup();
    f.store.start();
    await f.store.refresh();
    f.sockets[0].open();
    const next = { ...identity, user: { ...identity.user, id: 'fixture-two' } };
    const pending = deferred<Response>();
    f.fetcher.mockReturnValueOnce(pending.promise);
    f.runtime.queryClient.setQueryData(['private'], 'old data');
    f.runtime.refreshSession();
    expect(f.store.getSnapshot()).toEqual({ status: 'loading' });
    expect(f.sockets[0].close).toHaveBeenCalled();
    expect(f.runtime.queryClient.getQueryData(['private'])).toBeUndefined();
    pending.resolve(jsonResponse({ success: true, data: next }));
    await f.store.refresh();
    expect(f.store.getSnapshot()).toEqual({
      status: 'authenticated',
      identity: next,
    });
    expect(f.socket).toHaveBeenCalledTimes(2);
  });
  it('survives StrictMode stop/start without allowing the first response to replace the second', async () => {
    const f = setup();
    const first = deferred<Response>();
    f.fetcher.mockReturnValueOnce(first.promise);
    f.store.start();
    const old = f.store.refresh();
    f.store.stop();
    f.store.start();
    await f.store.refresh();
    await old;
    first.resolve(
      jsonResponse({
        success: true,
        data: { ...identity, user: { ...identity.user, id: 'stale' } },
      }),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(f.store.getSnapshot()).toEqual({
      status: 'authenticated',
      identity,
    });
    expect(f.socket).toHaveBeenCalledOnce();
  });
  it('verifies login through current-user and never stores the returned token', async () => {
    const f = setup();
    f.fetcher.mockResolvedValueOnce(jsonResponse({ errorCode: 401 }, 401));
    f.store.start();
    await f.store.refresh();
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { ...identity, token: 'fixture-token-never-persist' },
      }),
    );
    expect(
      (
        await f.store.login({
          username: 'fixture',
          password: 'Fixture-Password-55',
        })
      ).status,
    ).toBe('authenticated');
    expect(new URL(String(f.fetcher.mock.calls.at(-1)![0])).pathname).toBe(
      '/api/v1/auth/current-user',
    );
    expect(JSON.stringify(f.store.getSnapshot())).not.toContain(
      'fixture-token',
    );
    expect(JSON.stringify([...f.local, ...f.session])).not.toContain(
      'fixture-token',
    );
  });
  it('requires a new verification when login succeeds but current-user is unavailable', async () => {
    const f = setup();
    f.fetcher.mockResolvedValueOnce(jsonResponse({ errorCode: 401 }, 401));
    f.store.start();
    await f.store.refresh();
    f.fetcher
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { ...identity, token: 'fixture-token' },
        }),
      )
      .mockRejectedValueOnce(new Error('offline'));
    expect(
      (
        await f.store.login({
          username: 'fixture',
          password: 'Fixture-Password-55',
        })
      ).status,
    ).toBe('error');
    expect(f.socket).not.toHaveBeenCalled();
  });
  it('clears local identity on failed logout without claiming server revocation', async () => {
    const f = setup();
    f.store.start();
    await f.store.refresh();
    f.fetcher.mockRejectedValueOnce(new Error('offline'));
    await expect(f.store.logout()).rejects.toMatchObject({ kind: 'NETWORK' });
    expect(f.store.getSnapshot()).toEqual({ status: 'anonymous' });
    expect(f.sockets[0].close).toHaveBeenCalled();
  });
  it('does not globally sign out on a business permission 403', async () => {
    const f = setup();
    f.store.start();
    await f.store.refresh();
    f.fetcher.mockResolvedValueOnce(jsonResponse({ errorCode: 403 }, 403));
    await expect(
      f.runtime.http.request('/api/v1/protected'),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.store.getSnapshot().status).toBe('authenticated');
  });
  it('clears old cached data when a cookie changes without a storage event, including after a network failure', async () => {
    const f = setup();
    f.store.start();
    await f.store.refresh();
    f.runtime.queryClient.setQueryData(['private'], 'first user data');
    f.fetcher.mockRejectedValueOnce(new Error('offline'));
    await f.store.refresh();
    expect(f.store.getSnapshot().status).toBe('error');
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { ...identity, user: { ...identity.user, id: 'second-user' } },
      }),
    );
    await f.store.refresh();
    expect(f.runtime.queryClient.getQueryData(['private'])).toBeUndefined();
    expect(f.store.getSnapshot().status).toBe('authenticated');
  });
});
