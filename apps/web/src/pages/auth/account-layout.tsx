import { Link } from '@tanstack/react-router';
import { LogOut } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useAuth, useIdentity } from '../../auth/context';
import { Button } from '../../components/ui/button';

export function AccountLayout({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const { identity, announce } = useAuth();
  const auth = useIdentity();
  const [pending, setPending] = useState(false);
  async function logout() {
    setPending(true);
    try {
      await identity.logout();
    } catch {
      announce('已退出本机登录，未能确认服务器会话撤销。');
    } finally {
      setPending(false);
    }
  }
  return (
    <div className="min-h-screen">
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-5 py-4 sm:px-8">
          <Link to="/home" className="flex items-center gap-3 font-semibold">
            <span className="grid size-9 place-content-center rounded-control bg-ink text-signal">
              A
            </span>
            <span className="text-sm">ASIN Monitor</span>
          </Link>
          <nav
            aria-label="账号导航"
            className="flex items-center gap-3 text-sm"
          >
            <Link
              to="/profile"
              className="max-w-40 truncate rounded-pill px-3 py-2 hover:bg-muted"
            >
              {auth.status === 'authenticated'
                ? auth.identity.user.real_name || auth.identity.user.username
                : '个人中心'}
            </Link>
            <Button
              variant="ghost"
              size="small"
              pending={pending}
              onClick={() => {
                void logout();
              }}
            >
              <LogOut aria-hidden="true" />
              退出
            </Button>
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-12">
        <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
          YOUR WORKSPACE
        </p>
        <h1 className="mt-3 mb-8 text-3xl font-bold tracking-tight">{title}</h1>
        {children}
      </main>
    </div>
  );
}
