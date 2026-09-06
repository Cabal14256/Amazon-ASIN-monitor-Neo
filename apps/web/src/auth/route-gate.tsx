import { Link, Navigate, useRouterState } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Button } from '../components/ui/button';
import { useAuth, useIdentity } from './context';
import { evaluateRouteAccess } from './navigation';
import { routerDestination } from './router-navigation';

export function IdentityPending() {
  return (
    <main className="grid min-h-screen place-content-center p-6">
      <p
        role="status"
        className="rounded-pill bg-card px-6 py-4 text-sm text-muted-foreground"
      >
        正在验证登录状态…
      </p>
    </main>
  );
}
export function IdentityUnavailable() {
  const { identity } = useAuth();
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 px-6">
      <p className="text-xs font-semibold tracking-widest text-muted-foreground">
        AMAZON ASIN MONITOR
      </p>
      <h1 className="text-3xl font-bold">暂时无法验证登录状态</h1>
      <p role="alert" className="text-sm leading-6 text-muted-foreground">
        请检查网络连接后重试。
      </p>
      <Button
        onClick={() => {
          void identity.refresh();
        }}
      >
        重试
      </Button>
    </main>
  );
}
export function UnknownPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-5 px-6">
      <p className="font-mono text-sm text-muted-foreground">404</p>
      <h1 className="text-3xl font-bold">没有找到这个页面</h1>
      <Link to="/home" className="font-semibold underline underline-offset-4">
        返回首页
      </Link>
    </main>
  );
}
export function RouteGate({ children }: { children: ReactNode }) {
  const auth = useIdentity();
  const target = useRouterState({
    select: (state) =>
      state.location.pathname +
      state.location.searchStr +
      state.location.hash.replace(/^#?(.+)$/, '#$1'),
  });
  const decision = evaluateRouteAccess(target, auth);
  if (decision.type === 'pending') return <IdentityPending />;
  if (decision.type === 'unavailable') return <IdentityUnavailable />;
  if (decision.type === 'redirect')
    return <Navigate {...routerDestination(decision.to)} />;
  if (decision.type === 'not-found') return <UnknownPage />;
  return children;
}
