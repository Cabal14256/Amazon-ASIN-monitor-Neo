import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/http';
import {
  deferred,
  FakeSocket,
  jsonResponse,
  sessionFixture,
} from '../lib/transport-fixtures';
import { createTransportRuntime } from './runtime';

const loginData = {
  token: 'fixture-new-token-never-stored',
  sessionId: 'fixture-session',
  user: {
    id: 'fixture-user',
    username: 'fixture',
    status: 'ACTIVE',
    force_password_change: false,
  },
  permissions: ['asin:read'],
  roles: ['USER'],
  mustChangePassword: false,
  passwordExpired: false,
};
const runtimes: ReturnType<typeof createTransportRuntime>[] = [];
function setup() {
  const fixture = sessionFixture();
  const fetcher = vi.fn<typeof fetch>(async () =>
    jsonResponse({ success: true, errorCode: 0 }),
  );
  const sockets: FakeSocket[] = [];
  const socket = vi.fn(() => {
    const value = new FakeSocket();
    sockets.push(value);
    return value;
  });
  const onUnauthorized = vi.fn();
  const runtime = createTransportRuntime({
    pageOrigin: 'https://app.test',
    session: fixture.store,
    fetch: fetcher,
    socket,
    onUnauthorized,
  });
  runtimes.push(runtime);
  return {
    ...fixture,
    ...runtime,
    sessionValues: fixture.session,
    fetcher,
    socket,
    sockets,
    onUnauthorized,
  };
}
afterEach(() => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});
describe('shared runtime and seven auth endpoints', () => {
  it('creates one inert runtime and does not automatically authenticate or connect', () => {
    const f = setup();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.socket).not.toHaveBeenCalled();
    expect(f.queryClient.getDefaultOptions().mutations?.retry).toBe(false);
    expect(f.queryClient.getDefaultOptions().queries?.staleTime).toBe(30000);
  });
  it.each([false, true])(
    'login keeps the envelope but only persists a hint (remember=%s)',
    async (rememberMe) => {
      const f = setup();
      f.fetcher.mockResolvedValueOnce(
        jsonResponse({ success: true, data: loginData, errorCode: 0 }),
      );
      const result = await f.auth.login({
        username: 'fixture',
        password: 'fixture-password',
        rememberMe,
      });
      expect(result.data).toEqual(loginData);
      expect(f.store.isRemembered()).toBe(rememberMe);
      expect(f.store.hasSession()).toBe(true);
      expect(f.store.getLegacyToken()).toBeNull();
      expect(JSON.stringify([...f.local, ...f.sessionValues])).not.toContain(
        loginData.token,
      );
      expect(f.fetcher.mock.calls[0][0]).toBe(
        'https://app.test/api/v1/auth/login',
      );
    },
  );
  it('defaults omitted rememberMe to the server false value and resets stale user work on new login', async () => {
    const f = setup();
    f.store.markAuthenticated();
    f.ws.connect();
    f.sockets[0].open();
    f.queryClient.setQueryData(['old-user'], { private: 'fixture' });
    const old = vi.fn();
    f.ws.onMessage(old);
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({ success: true, data: loginData }),
    );
    await f.auth.login({ username: 'fixture', password: 'fixture-password' });
    expect(f.store.isRemembered()).toBe(false);
    expect(f.sockets[0].close).toHaveBeenCalled();
    f.sockets[0].message({ type: 'pong' });
    expect(old).not.toHaveBeenCalled();
    expect(f.queryClient.getQueryData(['old-user'])).toBeUndefined();
  });
  it('preserves AUTH when expiry resets the runtime and aborts other pending requests', async () => {
    const f = setup();
    f.store.markAuthenticated();
    f.ws.connect();
    f.sockets[0].open();
    const other = deferred<Response>();
    f.fetcher
      .mockReturnValueOnce(other.promise)
      .mockResolvedValueOnce(jsonResponse({ errorCode: 401 }, 401));
    const pending = f.http.request('/v1/slow').catch((error: unknown) => error);
    await expect(f.http.request('/v1/auth/current-user')).rejects.toMatchObject(
      { kind: 'AUTH' },
    );
    expect(await pending).toMatchObject({ kind: 'CANCELLED' });
    expect(f.onUnauthorized).toHaveBeenCalledTimes(1);
    expect(f.store.hasSession()).toBe(false);
    expect(f.sockets[0].close).toHaveBeenCalled();
    other.resolve(jsonResponse({ success: true }));
  });
  it('does not clear an existing session for a login credential rejection', async () => {
    const f = setup();
    f.store.markAuthenticated();
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({ success: false, errorCode: 401 }, 401),
    );
    await expect(
      f.auth.login({ username: 'fixture', password: 'bad' }),
    ).rejects.toMatchObject({ kind: 'AUTH' });
    expect(f.store.hasSession()).toBe(true);
    expect(f.onUnauthorized).not.toHaveBeenCalled();
  });
  it('uses the remaining six auth paths and methods without dropping their message envelopes', async () => {
    const f = setup();
    f.fetcher
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { ...loginData, token: undefined },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, data: [] }))
      .mockResolvedValueOnce(
        jsonResponse({ success: true, message: '已踢出会话', errorCode: 0 }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: true, message: '密码修改成功' }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: { user: loginData.user, roles: [], permissions: [] },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: true, message: '登出成功' }),
      );
    await f.auth.currentUser();
    await f.auth.sessions();
    expect((await f.auth.revokeSession('session-id')).message).toBe(
      '已踢出会话',
    );
    await f.auth.changePassword({
      oldPassword: 'fixture-old',
      newPassword: 'Fixture123',
      revokeOtherSessions: true,
    });
    await f.auth.updateProfile({ real_name: 'fixture' });
    expect((await f.auth.logout()).message).toBe('登出成功');
    expect(
      f.fetcher.mock.calls.map(([url, init]) => [
        new URL(String(url)).pathname,
        init?.method,
      ]),
    ).toEqual([
      ['/api/v1/auth/current-user', 'GET'],
      ['/api/v1/auth/sessions', 'GET'],
      ['/api/v1/auth/sessions/revoke', 'POST'],
      ['/api/v1/auth/change-password', 'POST'],
      ['/api/v1/auth/profile', 'PUT'],
      ['/api/v1/auth/logout', 'POST'],
    ]);
  });
  it('clears local hints even when server logout fails, without claiming remote revocation', async () => {
    const f = setup();
    f.store.markAuthenticated();
    f.fetcher.mockRejectedValueOnce(new Error('offline'));
    await expect(f.auth.logout()).rejects.toMatchObject({ kind: 'NETWORK' });
    expect(f.store.hasSession()).toBe(false);
  });
  it('serializes login/logout transitions and ignores a late login after local reset', async () => {
    const f = setup();
    const gate = deferred<Response>();
    f.fetcher.mockReturnValueOnce(gate.promise);
    const login = f.auth
      .login({ username: 'fixture', password: 'fixture' })
      .catch((error: unknown) => error);
    await expect(f.auth.logout()).rejects.toMatchObject({ kind: 'CAPACITY' });
    f.reset();
    expect(await login).toMatchObject({ kind: 'CANCELLED' });
    gate.resolve(jsonResponse({ success: true, data: loginData }));
    await Promise.resolve();
    expect(f.store.hasSession()).toBe(false);
  });
  it('discards old user work when browser storage indicates a session change', () => {
    const f = setup();
    f.store.markAuthenticated();
    f.ws.connect();
    f.sockets[0].open();
    const revision = f.store.revision;
    f.queryClient.setQueryData(['old-user'], { private: 'fixture' });
    f.refreshSession();
    expect(f.store.revision).toBeGreaterThan(revision);
    expect(f.sockets[0].close).toHaveBeenCalled();
    expect(f.queryClient.getQueryData(['old-user'])).toBeUndefined();
    expect(f.socket).toHaveBeenCalledTimes(1); // Reauthentication/reconnect is an auth-context responsibility.
  });
  it('blocks automatic Query retry for business errors and never retries mutations', async () => {
    const f = setup();
    const mutation = vi.fn(async () => {
      throw new ApiError('NETWORK', 'fixture');
    });
    const query = vi.fn(async () => {
      throw new ApiError('BUSINESS', 'fixture');
    });
    await expect(
      f.queryClient.fetchQuery({ queryKey: ['failure'], queryFn: query }),
    ).rejects.toMatchObject({ kind: 'BUSINESS' });
    expect(query).toHaveBeenCalledTimes(1);
    const instance = f.queryClient
      .getMutationCache()
      .build(f.queryClient, { mutationFn: mutation });
    await expect(instance.execute(undefined)).rejects.toMatchObject({
      kind: 'NETWORK',
    });
    expect(mutation).toHaveBeenCalledTimes(1);
  });
});
