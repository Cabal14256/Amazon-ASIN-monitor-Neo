import { createMemoryHistory } from '@tanstack/react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdentityStore } from './auth/identity';
import {
  deferred,
  FakeSocket,
  jsonResponse,
  sessionFixture,
} from './lib/transport-fixtures';
import { createAppRouter } from './router';
import { createTransportRuntime } from './services/runtime';

const user = {
  user: {
    id: 'router-user',
    username: 'fixture',
    status: 'ACTIVE',
    force_password_change: false,
  },
  sessionId: 'router-session',
  permissions: ['asin:read'],
  roles: ['USER'],
  mustChangePassword: false,
  passwordExpired: false,
};
const cleanups: (() => void)[] = [];
function setup(
  path: string,
  response: () => Promise<Response> = async () =>
    jsonResponse({ success: true, data: user }),
) {
  const fetcher = vi.fn<typeof fetch>(response);
  const runtime = createTransportRuntime({
    pageOrigin: 'https://app.test',
    session: sessionFixture().store,
    fetch: fetcher,
    socket: () => new FakeSocket(),
  });
  const identity = new IdentityStore(runtime);
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter(identity, history);
  router.update({
    isServer: false,
    origin: 'https://app.test',
    context: { identity },
  });
  cleanups.push(() => {
    identity.stop();
    runtime.dispose();
    history.destroy();
  });
  return { router, identity, runtime, fetcher };
}
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('application router identity boundary', () => {
  it('preserves the protected destination through the real beforeLoad redirect', async () => {
    const f = setup('/asin?keyword=fixture#row-2', async () =>
      jsonResponse({ success: false, errorCode: 401 }, 401),
    );
    await f.router.load();
    expect(f.router.state.location.href).toBe(
      '/login?redirect=%2Fasin%3Fkeyword%3Dfixture%23row-2',
    );
  });
  it('waits for server identity before completing a protected route load', async () => {
    const response = deferred<Response>();
    const f = setup('/profile', () => response.promise);
    const loaded = f.router.load();
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    expect(f.identity.getSnapshot().status).toBe('loading');
    expect(
      f.router.state.matches.some(
        (match) => match.routeId === '/profile' && match.status === 'success',
      ),
    ).toBe(false);
    response.resolve(jsonResponse({ success: true, data: user }));
    await loaded;
    expect(
      f.router.state.matches.find((match) => match.routeId === '/profile')
        ?.status,
    ).toBe('success');
  });
  it.each([
    '/home',
    '/asin',
    '/asin-parent-query',
    '/competitor-asin',
    '/tasks',
    '/profile',
  ])('loads the permitted page %s', async (path) => {
    const f = setup(path);
    await f.router.load();
    expect(f.router.state.location.pathname).toBe(path);
    expect(
      f.router.state.matches.find((match) => match.routeId === path)?.status,
    ).toBe('success');
  });
  it.each([
    '/monitor-history',
    '/competitor-monitor-history',
    '/analytics',
    '/settings',
    '/ops',
    '/user-management',
    '/audit-log',
  ])('blocks the ungranted page %s', async (path) => {
    const f = setup(path);
    await f.router.load();
    expect(f.router.state.location.href).toBe('/403');
    expect(f.identity.getSnapshot().status).toBe('authenticated');
  });
  it('returns to a permitted local location after login', async () => {
    const f = setup('/login?redirect=%2Fprofile%3Ftab%3Dsessions%23device');
    await f.router.load();
    expect(f.router.state.location.href).toBe('/profile?tab=sessions#device');
  });
  it.each(['/login', '/403', '/asin'])(
    'requires a password change before visiting %s',
    async (path) => {
      const f = setup(path, async () =>
        jsonResponse({
          success: true,
          data: { ...user, mustChangePassword: true },
        }),
      );
      await f.router.load();
      expect(f.router.state.location.href).toBe(
        '/profile?tab=password&force=1',
      );
    },
  );
  it('keeps identity failure unavailable without redirecting to login or granting a cached user', async () => {
    const f = setup('/profile', async () => {
      throw new Error('offline fixture');
    });
    f.runtime.session.markAuthenticated();
    await f.router.load();
    expect(f.identity.getSnapshot()).toEqual({ status: 'error' });
    expect(f.router.state.location.pathname).toBe('/profile');
  });
  it('redirects the index to home after verification', async () => {
    const f = setup('/');
    await f.router.load();
    expect(f.router.state.location.href).toBe('/home');
  });
});
