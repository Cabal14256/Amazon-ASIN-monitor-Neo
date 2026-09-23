import { Link, useRouterState } from '@tanstack/react-router';
import {
  ChevronRight,
  LogOut,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  X,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { createAccess } from '../auth/access';
import { useAuth, useIdentity } from '../auth/context';
import { cn } from '../lib/utils';
import { workspaceNavigation } from './app-shell-navigation';
import { Button } from './ui/button';

const COLLAPSE_KEY = 'asin-monitor-neo-sidebar-collapsed';
function initialCollapsed() {
  try {
    return (
      typeof window !== 'undefined' &&
      window.localStorage.getItem(COLLAPSE_KEY) === '1'
    );
  } catch {
    return false;
  }
}

export function AppShell({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  const { identity, announce } = useAuth();
  const auth = useIdentity();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const [collapsed, setCollapsed] = useState(initialCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const access = createAccess(
    auth.status === 'authenticated' ? auth.identity : undefined,
  );
  const displayName =
    auth.status === 'authenticated'
      ? auth.identity.user.real_name || auth.identity.user.username
      : '账号';
  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    try {
      window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
    } catch {
      /* The current view still works when storage is disabled. */
    }
  }
  async function logout() {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await identity.logout();
    } catch {
      announce('已退出本机登录，未能确认服务器会话撤销。');
    } finally {
      setLoggingOut(false);
    }
  }
  const navigation = (
    <nav aria-label="主导航" className="flex-1 overflow-y-auto px-3 py-5">
      {workspaceNavigation(access).map((section) => {
        const items = section.items;
        return (
          <div key={section.label} className="mb-6">
            <p
              className={cn(
                'mb-2 px-3 text-[11px] font-semibold tracking-[.18em] text-muted-foreground',
                collapsed && 'lg:sr-only',
              )}
            >
              {section.label}
            </p>
            <div className="space-y-1">
              {items.map((item) => {
                const Icon = item.icon;
                const current = pathname === item.path;
                const classes = cn(
                  'flex min-h-11 items-center gap-3 rounded-control px-3 text-sm transition-colors',
                  current
                    ? 'bg-ink font-semibold text-white'
                    : 'text-foreground hover:bg-muted',
                  !item.available && 'cursor-not-allowed text-muted-foreground',
                  collapsed && 'lg:justify-center',
                );
                const content = (
                  <>
                    <Icon aria-hidden="true" className="size-[18px] shrink-0" />
                    <span
                      className={cn(
                        'min-w-0 flex-1 truncate',
                        collapsed && 'lg:sr-only',
                      )}
                    >
                      {item.label}
                    </span>
                    {!item.available && (
                      <span
                        className={cn(
                          'shrink-0 text-[10px] text-muted-foreground',
                          collapsed && 'lg:sr-only',
                        )}
                      >
                        迁移中
                      </span>
                    )}
                    {item.available && current && (
                      <ChevronRight
                        aria-hidden="true"
                        className={cn('size-3.5', collapsed && 'lg:hidden')}
                      />
                    )}
                  </>
                );
                return item.available ? (
                  <Link
                    key={item.path}
                    to={item.path}
                    aria-current={current ? 'page' : undefined}
                    aria-label={collapsed ? item.label : undefined}
                    title={collapsed ? item.label : undefined}
                    onClick={() => setMobileOpen(false)}
                    className={classes}
                  >
                    {content}
                  </Link>
                ) : (
                  <span
                    key={item.path}
                    aria-disabled="true"
                    title={item.label + ' · 迁移中'}
                    className={classes}
                  >
                    {content}
                  </span>
                );
              })}
            </div>
          </div>
        );
      })}
    </nav>
  );
  return (
    <div className="flex min-h-screen bg-cream">
      <a
        href="#workspace-content"
        className="sr-only rounded-pill bg-signal px-5 py-3 font-semibold focus:fixed focus:top-3 focus:left-3 focus:z-[60] focus:not-sr-only"
      >
        跳到主要内容
      </a>
      {mobileOpen && (
        <button
          type="button"
          aria-label="关闭导航"
          onClick={() => setMobileOpen(false)}
          className="fixed inset-0 z-30 bg-ink/45 lg:hidden"
        />
      )}
      <aside
        className={cn(
          'invisible fixed inset-y-0 left-0 z-40 flex w-[264px] shrink-0 -translate-x-full flex-col border-r border-border bg-card transition-transform duration-300 lg:visible lg:sticky lg:top-0 lg:z-10 lg:h-screen lg:translate-x-0',
          mobileOpen && 'visible translate-x-0',
          collapsed && 'lg:w-20',
        )}
      >
        <div className="flex h-20 items-center justify-between gap-2 border-b border-border px-5 lg:px-4">
          <Link
            to={access.mustChangePassword ? '/profile' : '/home'}
            aria-label="返回监控总览"
            onClick={() => setMobileOpen(false)}
            className="flex min-w-0 items-center gap-3"
          >
            <span className="grid size-10 shrink-0 place-items-center rounded-control bg-ink text-lg font-black text-signal">
              A
            </span>
            <span
              className={cn(
                'min-w-0 text-sm font-black tracking-tight',
                collapsed && 'lg:sr-only',
              )}
            >
              ASIN MONITOR{' '}
              <span className="block text-xs font-medium text-muted-foreground">
                Neo 工作台
              </span>
            </span>
          </Link>
          <button
            type="button"
            aria-label="关闭导航"
            onClick={() => setMobileOpen(false)}
            className="rounded-control p-2 hover:bg-muted lg:hidden"
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        </div>
        {navigation}
        <div className="border-t border-border p-3">
          <button
            type="button"
            aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
            onClick={toggleCollapsed}
            className="hidden min-h-10 w-full items-center gap-3 rounded-control px-3 text-sm text-muted-foreground hover:bg-muted lg:flex"
          >
            {collapsed ? (
              <PanelLeftOpen aria-hidden="true" className="size-[18px]" />
            ) : (
              <PanelLeftClose aria-hidden="true" className="size-[18px]" />
            )}
            {!collapsed && '收起侧栏'}
          </button>
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-20 flex min-h-20 items-center justify-between gap-3 border-b border-border bg-cream/95 px-5 backdrop-blur-sm sm:px-8 lg:px-10">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              aria-label="打开导航"
              aria-expanded={mobileOpen}
              onClick={() => setMobileOpen(true)}
              className="rounded-control p-2 hover:bg-muted lg:hidden"
            >
              <Menu aria-hidden="true" className="size-5" />
            </button>
            <div className="min-w-0">
              <p className="hidden text-[11px] font-semibold tracking-[.18em] text-muted-foreground sm:block">
                WORKSPACE / NEO
              </p>
              <p className="truncate text-sm font-semibold">{title}</p>
            </div>
          </div>
          <div className="flex items-center gap-2 sm:gap-4">
            <Link
              to="/profile"
              className="max-w-32 truncate rounded-pill px-3 py-2 text-sm font-medium hover:bg-muted sm:max-w-48"
              title={displayName}
            >
              {displayName}
            </Link>
            <Button
              variant="ghost"
              size="small"
              pending={loggingOut}
              aria-label="退出登录"
              onClick={() => {
                void logout();
              }}
            >
              <LogOut aria-hidden="true" />{' '}
              <span className="hidden sm:inline">退出</span>
            </Button>
          </div>
        </header>
        <main
          id="workspace-content"
          tabIndex={-1}
          className="mx-auto w-full max-w-[1760px] px-5 py-7 sm:px-8 sm:py-9 lg:px-10"
        >
          {children}
        </main>
      </div>
    </div>
  );
}
