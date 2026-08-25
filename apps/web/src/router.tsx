import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
} from '@tanstack/react-router';

/**
 * 脚手架路由：P3-T2 将平移旧系统 15 个页面路由与权限 guard。
 */

const rootRoute = createRootRoute({
  component: () => (
    <div className="min-h-screen">
      <Outlet />
    </div>
  ),
});

const homeRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: function HomePlaceholder() {
    return (
      <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-start justify-center gap-4 px-6">
        <p className="text-sm tracking-widest text-neutral-500 uppercase">
          Amazon ASIN Monitor · Neo
        </p>
        <h1 className="text-4xl font-bold">
          重构脚手架已就绪
          <span className="ml-3 inline-block -rotate-2 rounded-md bg-[var(--color-signal)] px-2 py-1 text-2xl text-black">
            明快作业台
          </span>
        </h1>
        <p className="text-neutral-600">
          阶段 0 空骨架（Vite 6 + React 19 + TanStack + Tailwind 4 +
          shadcn/ui）。 页面将按总体计划 §7 四批迁移。
        </p>
      </main>
    );
  },
});

const routeTree = rootRoute.addChildren([homeRoute]);

export const router = createRouter({ routeTree });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
