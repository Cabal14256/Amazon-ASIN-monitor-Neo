import { ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createAccess } from '../../auth/access';
import { useAuth, useIdentity } from '../../auth/context';
import { AppShell } from '../../components/app-shell';
import { Button } from '../../components/ui/button';
import { UserManagementApi } from '../../services/user-management';
import { ManagementContext } from './context';
import { PermissionPanel } from './permissions';
import { RolePanel } from './roles';
import { UserPanel } from './users';

type Tab = 'users' | 'roles' | 'permissions';

export default function UserManagementPage() {
  const { runtime, identity, announce } = useAuth();
  const auth = useIdentity();
  const current = auth.status === 'authenticated' ? auth.identity : undefined;
  const access = createAccess(current);
  const api = useMemo(
    () => new UserManagementApi(runtime.http),
    [runtime.http],
  );
  const tabs = useMemo<{ key: Tab; label: string }[]>(
    () => [
      ...(access.canReadUser
        ? [{ key: 'users' as const, label: '用户管理' }]
        : []),
      ...(access.canReadRole
        ? [
            { key: 'roles' as const, label: '角色管理' },
            { key: 'permissions' as const, label: '权限控制' },
          ]
        : []),
    ],
    [access.canReadUser, access.canReadRole],
  );
  const [tab, setTab] = useState<Tab>(access.canReadUser ? 'users' : 'roles');
  const [notice, setNotice] = useState<string | null>(null);
  const [accessDenied, setAccessDenied] = useState(false);
  const denialReported = useRef(false);
  const reportAccessDenied = useCallback(() => {
    if (denialReported.current) return;
    denialReported.current = true;
    setAccessDenied(true);
  }, []);
  useEffect(() => {
    if (!accessDenied) return;
    runtime.clearUserWork();
    void identity.refresh();
  }, [accessDenied, identity, runtime]);
  useEffect(() => {
    if (tabs.length > 0 && !tabs.some((item) => item.key === tab))
      setTab(tabs[0].key);
  }, [tab, tabs]);
  const afterWrite = useCallback(
    async (message: string, refreshIdentity = false) => {
      setNotice(message);
      announce(message);
      if (refreshIdentity) {
        // A role or self mutation may revoke this session's permissions.
        runtime.clearUserWork();
        await identity.refresh();
      } else {
        await runtime.queryClient.invalidateQueries({
          queryKey: ['management'],
        });
      }
    },
    [announce, identity, runtime],
  );
  const context = {
    api,
    access,
    currentUserId: current?.user.id ?? null,
    accessDenied,
    reportAccessDenied,
    afterWrite,
  };
  return (
    <ManagementContext.Provider value={context}>
      <AppShell title="用户与权限">
        <div className="space-y-6">
          <section className="rounded-card bg-ink px-6 py-7 text-white sm:px-8">
            <span className="inline-flex items-center gap-2.5 text-xs font-semibold">
              <ShieldCheck aria-hidden="true" className="size-4 text-signal" />
              GOVERNANCE / 用户与权限
            </span>
            <h1 className="mt-4 text-3xl font-black tracking-tight">
              用户与权限管理
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-white/65">
              管理用户状态、角色和权限。保存后重新验证当前身份与访问范围。
            </p>
          </section>
          {notice && (
            <p
              role="status"
              className="rounded-control bg-status-success-soft p-4 text-sm text-status-success"
            >
              {notice}
            </p>
          )}
          <div
            role="tablist"
            aria-label="用户权限管理页签"
            className="flex flex-wrap gap-2 border-b border-border pb-3"
          >
            {tabs.map((item) => (
              <Button
                key={item.key}
                role="tab"
                aria-selected={tab === item.key}
                variant={tab === item.key ? 'primary' : 'secondary'}
                size="small"
                onClick={() => {
                  setNotice(null);
                  setTab(item.key);
                }}
              >
                {item.label}
              </Button>
            ))}
          </div>
          {accessDenied ? (
            <p role="alert" className="text-sm text-status-warning">
              访问权限可能已变更，正在重新验证当前身份…
            </p>
          ) : (
            <>
              {tab === 'users' && access.canReadUser && <UserPanel />}
              {tab === 'roles' && access.canReadRole && <RolePanel />}
              {tab === 'permissions' && access.canReadRole && (
                <PermissionPanel />
              )}
            </>
          )}
        </div>
      </AppShell>
    </ManagementContext.Provider>
  );
}
