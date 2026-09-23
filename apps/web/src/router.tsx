import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  type RouterHistory,
} from '@tanstack/react-router';
import { lazy, Suspense } from 'react';
import type { IdentityStore } from './auth/identity';
import { evaluateRouteAccess } from './auth/navigation';
import { PAGE_ROUTES } from './auth/pages';
import { IdentityPending, RouteGate, UnknownPage } from './auth/route-gate';
import { routerDestination } from './auth/router-navigation';

const LoginPage = lazy(() => import('./pages/auth/login'));
const ProfilePage = lazy(() => import('./pages/auth/profile'));
const ForbiddenPage = lazy(() => import('./pages/auth/forbidden'));
const HomePage = lazy(() => import('./pages/home'));
const AsinCatalogPage = lazy(() => import('./pages/asin'));
const CompetitorAsinCatalogPage = lazy(() => import('./pages/competitor-asin'));
const TaskCenterPage = lazy(() => import('./pages/tasks'));
const UnavailablePage = lazy(() => import('./pages/unavailable'));
const DesignPreview = import.meta.env.DEV
  ? lazy(() => import('./pages/dev/design-system'))
  : undefined;

export function createAppRouter(
  identity: IdentityStore,
  history?: RouterHistory,
) {
  const root = createRootRouteWithContext<{ identity: IdentityStore }>()({
    component: Outlet,
    notFoundComponent: UnknownPage,
  });
  const routes = PAGE_ROUTES.map((page) =>
    createRoute({
      getParentRoute: () => root,
      path: page.path,
      beforeLoad: async ({ context, location }) => {
        const state = await context.identity.ensure();
        const decision = evaluateRouteAccess(location.href, state);
        if (decision.type === 'redirect')
          throw redirect(routerDestination(decision.to));
      },
      component: function PageRoute() {
        return (
          <RouteGate>
            <Suspense fallback={<IdentityPending />}>
              {page.path === '/login' ? (
                <LoginPage />
              ) : page.path === '/profile' ? (
                <ProfilePage />
              ) : page.path === '/403' ? (
                <ForbiddenPage />
              ) : page.path === '/home' ? (
                <HomePage />
              ) : page.path === '/asin' ? (
                <AsinCatalogPage />
              ) : page.path === '/competitor-asin' ? (
                <CompetitorAsinCatalogPage />
              ) : page.path === '/tasks' ? (
                <TaskCenterPage />
              ) : (
                <UnavailablePage title={page.name} />
              )}
            </Suspense>
          </RouteGate>
        );
      },
    }),
  );
  const index = createRoute({
    getParentRoute: () => root,
    path: '/',
    beforeLoad: async ({ context, location }) => {
      const decision = evaluateRouteAccess(
        location.href,
        await context.identity.ensure(),
      );
      if (decision.type === 'redirect')
        throw redirect(routerDestination(decision.to));
    },
    component: () => (
      <RouteGate>
        <IdentityPending />
      </RouteGate>
    ),
  });
  const previews = DesignPreview
    ? [
        createRoute({
          getParentRoute: () => root,
          path: '/__dev/design-system',
          component: function Preview() {
            const Component = DesignPreview!;
            return (
              <Suspense fallback={<IdentityPending />}>
                <Component />
              </Suspense>
            );
          },
        }),
      ]
    : [];
  return createRouter({
    routeTree: root.addChildren([index, ...routes, ...previews]),
    history,
    context: { identity },
    defaultPendingComponent: IdentityPending,
    defaultPreload: false,
  });
}
declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof createAppRouter>;
  }
}
