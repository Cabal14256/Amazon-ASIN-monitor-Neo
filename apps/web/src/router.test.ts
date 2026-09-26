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
    const f =
      path === '/ops'
        ? setup(path, async () =>
            jsonResponse({
              success: true,
              data: { ...user, permissions: ['settings:read'] },
            }),
          )
        : setup(path);
    await f.router.load();
    expect(f.router.state.location.pathname).toBe(path);
    expect(
      f.router.state.matches.find((match) => match.routeId === path)?.status,
    ).toBe('success');
  });
  it('opens analytics with the analytics read grant', async () => {
    const f = setup('/analytics', async () =>
      jsonResponse({
        success: true,
        data: { ...user, permissions: ['analytics:read'] },
      }),
    );
    await f.router.load();
    expect(f.router.state.location.pathname).toBe('/analytics');
    expect(
      f.router.state.matches.find((match) => match.routeId === '/analytics')
        ?.status,
    ).toBe('success');
  });
  it.each(['/analytics', '/settings', '/ops', '/user-management'])(
    'blocks the ungranted page %s',
    async (path) => {
      const f = setup(path);
      await f.router.load();
      expect(f.router.state.location.href).toBe('/403');
      expect(f.identity.getSnapshot().status).toBe('authenticated');
    },
  );
  it.each(['user:read', 'role:read'])(
    'opens user management with the current %s permission',
    async (permission) => {
      const granted = setup('/user-management', async () =>
        jsonResponse({
          success: true,
          data: { ...user, permissions: [permission] },
        }),
      );
      await granted.router.load();
      expect(granted.router.state.location.pathname).toBe('/user-management');
      expect(
        granted.router.state.matches.find(
          (match) => match.routeId === '/user-management',
        )?.status,
      ).toBe('success');
    },
  );
  it.each(['/monitor-history', '/competitor-monitor-history'])(
    'opens %s with the current monitor permission',
    async (path) => {
      const f = setup(path, async () =>
        jsonResponse({
          success: true,
          data: { ...user, permissions: ['asin:read', 'monitor:read'] },
        }),
      );
      await f.router.load();
      expect(f.router.state.location.pathname).toBe(path);
      expect(
        f.router.state.matches.find((match) => match.routeId === path)?.status,
      ).toBe('success');
    },
  );
  it('opens audit logs only with the current audit permission', async () => {
    const granted = setup('/audit-log', async () =>
      jsonResponse({
        success: true,
        data: { ...user, permissions: ['audit:read'] },
      }),
    );
    await granted.router.load();
    expect(granted.router.state.location.pathname).toBe('/audit-log');
    expect(
      granted.router.state.matches.find(
        (match) => match.routeId === '/audit-log',
      )?.status,
    ).toBe('success');
    const denied = setup('/audit-log');
    await denied.router.load();
    expect(denied.router.state.location.href).toBe('/403');
  });
  it.each(['/monitor-history', '/competitor-monitor-history'])(
    'still blocks %s without monitor permission',
    async (path) => {
      const f = setup(path);
      await f.router.load();
      expect(f.router.state.location.href).toBe('/403');
    },
  );
  it('returns to a permitted local location after login', async () => {
    const f = setup('/login?redirect=%2Fprofile%3Ftab%3Dsessions%23device');
    await f.router.load();
    expect(f.router.state.location.href).toBe('/profile?tab=sessions#device');
  });
  it.each(['/login', '/403', '/asin', '/tasks'])(
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
