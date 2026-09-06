import {
  PERMISSION_CODES,
  type CurrentUserData,
} from '@asin-monitor/contracts';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createAccess } from './access';
import {
  evaluateRouteAccess,
  loginDestination,
  safeReturnTo,
} from './navigation';
import { PAGE_ROUTES, PASSWORD_CHANGE_PAGE } from './pages';

function identity(overrides: Partial<CurrentUserData> = {}): CurrentUserData {
  return {
    user: {
      id: 'fixture-user',
      username: 'fixture',
      status: 'ACTIVE',
      force_password_change: false,
    },
    roles: [],
    permissions: [],
    mustChangePassword: false,
    passwordExpired: false,
    ...overrides,
  };
}

interface LegacyRoute {
  path: string;
  component?: string;
  access?: string;
}
type LegacyAccess = (state: {
  currentUser?: CurrentUserData['user'];
  permissions?: string[];
  roles?: string[];
}) => Record<string, boolean>;
function loadLegacy(file: string, hint = false) {
  const source = readFileSync(
    new URL(`../../../../${file}`, import.meta.url),
    'utf8',
  );
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  });
  const exports: { default?: unknown } = {};
  runInNewContext(compiled.outputText, {
    exports,
    window: {},
    process: { env: { NODE_ENV: 'test' } },
    require: (name: string) => {
      if (name === '@umijs/max')
        return { defineConfig: (config: unknown) => config };
      if (name === '@/utils/token') return { hasAuthSession: () => hint };
      if (name === '@/utils/debug') return { debugLog: () => {} };
      throw new Error(`Unexpected Legacy import: ${name}`);
    },
  });
  return exports.default;
}
const legacyAccess = loadLegacy('src/access.ts') as LegacyAccess;
const legacyRoutes = (
  loadLegacy('.umirc.ts') as { routes: LegacyRoute[] }
).routes.filter((route) => route.component);

describe('access parity with the actual Legacy factory', () => {
  it.each(PERMISSION_CODES)(
    'preserves every access flag when only %s is granted',
    (permission) => {
      const principal = identity({ permissions: [permission] });
      expect(createAccess(principal)).toEqual(
        legacyAccess({
          currentUser: principal.user,
          permissions: principal.permissions,
          roles: principal.roles,
        }),
      );
    },
  );
  it.each(['ADMIN', 'EDITOR', 'READONLY', 'CUSTOM'])(
    'preserves %s role semantics without granting implicit permissions',
    (role) => {
      const principal = identity({ roles: [role] });
      expect(createAccess(principal)).toEqual(
        legacyAccess({
          currentUser: principal.user,
          permissions: [],
          roles: [role],
        }),
      );
      expect(createAccess(principal).canReadSettings).toBe(false);
    },
  );
  it('accepts either user:read or role:read for user management, not write-only privileges', () => {
    expect(
      createAccess(identity({ permissions: ['role:read'] }))
        .canAccessUserManagement,
    ).toBe(true);
    expect(
      createAccess(identity({ permissions: ['user:read'] }))
        .canAccessUserManagement,
    ).toBe(true);
    expect(
      createAccess(identity({ permissions: ['user:write', 'role:write'] }))
        .canAccessUserManagement,
    ).toBe(false);
  });
  it('does not treat a stale browser hint as server verification', () => {
    const hinted = loadLegacy('src/access.ts', true) as LegacyAccess;
    expect(hinted({}).isLogin).toBe(true);
    expect(Object.values(createAccess())).toEqual(Array(20).fill(false));
    expect(evaluateRouteAccess('/home', { status: 'loading' })).toEqual({
      type: 'pending',
    });
    expect(evaluateRouteAccess('/home', { status: 'error' })).toEqual({
      type: 'unavailable',
    });
  });
  it.each(['INACTIVE', 'LOCKED', 'SUSPENDED', 'PENDING'] as const)(
    'never grants a %s user access, even with all role and permission strings',
    (status) => {
      const principal = identity({
        roles: ['ADMIN'],
        permissions: [...PERMISSION_CODES],
      });
      principal.user.status = status;
      expect(
        Object.values(createAccess(principal)).every(
          (value) => value === false,
        ),
      ).toBe(true);
      expect(
        evaluateRouteAccess('/settings', {
          status: 'authenticated',
          identity: principal,
        }),
      ).toEqual({ type: 'redirect', to: loginDestination('/settings') });
    },
  );
  it('rejects empty identity and unknown/wildcard/case-mismatched permissions', () => {
    const principal = identity({
      permissions: ['*', 'ADMIN', 'ASIN:READ', 'users:read'],
    });
    expect(createAccess(principal).canReadASIN).toBe(false);
    principal.user.id = '';
    expect(createAccess(principal).isLogin).toBe(false);
  });
  it.each(['top-level', 'user', 'expired'])(
    'honors the %s password restriction',
    (source) => {
      const principal = identity();
      if (source === 'top-level') principal.mustChangePassword = true;
      if (source === 'user') principal.user.force_password_change = true;
      if (source === 'expired') principal.passwordExpired = true;
      expect(createAccess(principal).mustChangePassword).toBe(true);
      const auth = { status: 'authenticated', identity: principal } as const;
      for (const page of PAGE_ROUTES.filter(
        (page) => page.path !== '/profile',
      )) {
        expect(evaluateRouteAccess(page.path, auth)).toEqual({
          type: 'redirect',
          to: PASSWORD_CHANGE_PAGE,
        });
      }
      expect(
        evaluateRouteAccess('/profile?tab=password&force=1', auth).type,
      ).toBe('allow');
    },
  );
});

describe('15-page catalog and route decisions', () => {
  it('matches every actual Legacy component route and access key exactly', () => {
    expect(PAGE_ROUTES.map(({ path, access }) => ({ path, access }))).toEqual(
      legacyRoutes.map(({ path, access }) => ({
        path,
        access: access ?? 'public',
      })),
    );
    expect(PAGE_ROUTES).toHaveLength(15);
    expect(new Set(PAGE_ROUTES.map(({ path }) => path)).size).toBe(15);
  });
  it('matches all Legacy route permissions across the complete single-permission matrix', () => {
    for (const permissions of [[], ...PERMISSION_CODES.map((code) => [code])]) {
      const principal = identity({ permissions });
      const legacy = legacyAccess({ currentUser: principal.user, permissions });
      for (const route of legacyRoutes.filter((route) => route.access)) {
        const decision = evaluateRouteAccess(route.path, {
          status: 'authenticated',
          identity: principal,
        });
        expect(
          decision.type,
          `${route.path} with ${permissions.join(',')}`,
        ).toBe(legacy[route.access!] ? 'allow' : 'redirect');
        if (!legacy[route.access!])
          expect(decision).toEqual({ type: 'redirect', to: '/403' });
      }
    }
  });
  it('waits for verified auth, preserves the full return location, and exposes retry state', () => {
    for (const route of PAGE_ROUTES.filter(
      (page) => page.access !== 'public',
    )) {
      const target = `${route.path}?marketplace=US#selected`;
      expect(evaluateRouteAccess(target, { status: 'loading' })).toEqual({
        type: 'pending',
      });
      expect(evaluateRouteAccess(target, { status: 'error' })).toEqual({
        type: 'unavailable',
      });
      expect(evaluateRouteAccess(target, { status: 'anonymous' })).toEqual({
        type: 'redirect',
        to: loginDestination(target),
      });
    }
  });
  it('allows public 403 and login recovery without exposing protected pages', () => {
    for (const status of ['anonymous', 'error'] as const)
      expect(evaluateRouteAccess('/login', { status }).type).toBe('allow');
    expect(evaluateRouteAccess('/403', { status: 'loading' }).type).toBe(
      'allow',
    );
    expect(evaluateRouteAccess('/login', { status: 'loading' })).toEqual({
      type: 'pending',
    });
  });
  it('normalizes root and a single trailing slash while leaving unknown routes to not-found', () => {
    const auth = { status: 'authenticated', identity: identity() } as const;
    expect(evaluateRouteAccess('/?view=all#row', auth)).toEqual({
      type: 'redirect',
      to: '/home?view=all#row',
    });
    expect(evaluateRouteAccess('/profile/', auth).type).toBe('allow');
    expect(evaluateRouteAccess('/profile/edit', auth)).toEqual({
      type: 'not-found',
    });
    expect(evaluateRouteAccess('/feishu-config', auth)).toEqual({
      type: 'not-found',
    });
  });
  it('rechecks permission on a post-login return and never treats the return address as a grant', () => {
    const auth = { status: 'authenticated', identity: identity() } as const;
    expect(evaluateRouteAccess('/login?redirect=%2Fsettings', auth)).toEqual({
      type: 'redirect',
      to: '/settings',
    });
    expect(evaluateRouteAccess('/settings', auth)).toEqual({
      type: 'redirect',
      to: '/403',
    });
    expect(
      evaluateRouteAccess('/login?redirect=https%3A%2F%2Fexample.test', auth),
    ).toEqual({ type: 'redirect', to: '/home' });
  });
});

describe('safe internal login return addresses', () => {
  it.each([
    ['/asin?marketplace=US#row-2', '/asin?marketplace=US#row-2'],
    ['/profile/?tab=password', '/profile?tab=password'],
    ['/?view=all#top', '/home?view=all#top'],
    ['/asin?search=hello world', '/asin?search=hello%20world'],
    ['/asin?filter=%E4%B8%AD%E6%96%87', '/asin?filter=%E4%B8%AD%E6%96%87'],
    [
      '/home?source=https%3A%2F%2Fexample.test',
      '/home?source=https%3A%2F%2Fexample.test',
    ],
  ])('preserves known local target %s', (input, expected) => {
    expect(safeReturnTo(input)).toBe(expected);
    const login = new URL(loginDestination(input), 'https://app.test');
    expect(login.searchParams.get('redirect')).toBe(expected);
  });
  it.each([
    undefined,
    null,
    42,
    {},
    '',
    'home',
    'https://example.test/home',
    '//example.test/home',
    '///home',
    '\\example.test',
    '/\\example.test',
    '/home\\evil',
    'javascript:alert(1)',
    '/%2f%2fexample.test',
    '/%252f%252fexample.test',
    '/%68ome',
    '/home/../settings',
    '/home/.',
    '/home//',
    '/login?redirect=/login',
    '/403',
    '/unknown',
    '/home\n',
    '/home?x=\r\n',
    '/home?x=\0',
    '/home#\u007f',
    '/home?x=\ud800',
    '/home?x=' + 'a'.repeat(4096),
  ])('falls back for invalid, external or looping target %#', (input) => {
    expect(safeReturnTo(input)).toBe('/home');
    expect(loginDestination(input)).toBe('/login?redirect=%2Fhome');
  });
});
