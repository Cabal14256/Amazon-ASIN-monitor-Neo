import type { CurrentUserData } from '@asin-monitor/contracts';
import { createAccess } from './access';
import {
  DEFAULT_PAGE,
  findPage,
  PASSWORD_CHANGE_PAGE,
  type PageRoute,
} from './pages';

export type RouteAuthState =
  | { status: 'loading' }
  | { status: 'anonymous' }
  | { status: 'error' }
  | { status: 'authenticated'; identity: CurrentUserData };

export type RouteAccessDecision =
  | { type: 'allow'; page: PageRoute }
  | { type: 'redirect'; to: string }
  | { type: 'pending' }
  | { type: 'unavailable' }
  | { type: 'not-found' };

/** Parse an app location, not an arbitrary URL. URL normalization must not admit new paths. */
function appLocation(
  value: unknown,
): { url: URL; page: PageRoute } | undefined {
  if (
    typeof value !== 'string' ||
    value.length > 4096 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\')
  )
    return;
  if (
    [...value].some(
      (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
    )
  )
    return;
  const pathname = value.split(/[?#]/, 1)[0];
  const page = findPage(pathname === '/' ? DEFAULT_PAGE : pathname);
  if (!page) return;
  try {
    // Also reject malformed UTF-16 rather than silently replacing it while building the URL.
    encodeURI(value);
    const url = new URL(value, 'https://navigation.invalid');
    if (url.origin !== 'https://navigation.invalid') return;
    url.pathname = page.path;
    return { url, page };
  } catch {
    return;
  }
}

/** Input is the already decoded URLSearchParams value. Output is always a known local page. */
export function safeReturnTo(value: unknown): string {
  const location = appLocation(value);
  if (!location || location.page.access === 'public') return DEFAULT_PAGE;
  return location.url.pathname + location.url.search + location.url.hash;
}

export function loginDestination(returnTo: unknown): string {
  return `/login?redirect=${encodeURIComponent(safeReturnTo(returnTo))}`;
}

/** Side-effect-free policy for the later TanStack beforeLoad/auth-context integration. */
export function evaluateRouteAccess(
  target: string,
  auth: RouteAuthState,
): RouteAccessDecision {
  const location = appLocation(target);
  if (!location) return { type: 'not-found' };
  const { page, url } = location;
  const access = createAccess(
    auth.status === 'authenticated' ? auth.identity : undefined,
  );
  if (access.mustChangePassword && page.path !== '/profile')
    return { type: 'redirect', to: PASSWORD_CHANGE_PAGE };
  if (page.path === '/login') {
    if (auth.status === 'loading') return { type: 'pending' };
    if (access.isLogin)
      return {
        type: 'redirect',
        to: safeReturnTo(url.searchParams.get('redirect')),
      };
    return { type: 'allow', page };
  }
  if (page.access === 'public') return { type: 'allow', page };
  if (auth.status === 'loading') return { type: 'pending' };
  if (auth.status === 'error') return { type: 'unavailable' };
  if (!access.isLogin)
    return { type: 'redirect', to: loginDestination(target) };
  if (!access[page.access]) return { type: 'redirect', to: '/403' };
  if (target.split(/[?#]/, 1)[0] === '/')
    return { type: 'redirect', to: safeReturnTo(target) };
  return { type: 'allow', page };
}
