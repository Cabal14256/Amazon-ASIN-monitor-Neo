import { changePasswordRequestSchema } from '@asin-monitor/contracts';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { createAccess } from '../../auth/access';
import { useAuth, useIdentity } from '../../auth/context';
import { routerDestination } from '../../auth/router-navigation';
import { Button } from '../../components/ui/button';
import { Field, Input } from '../../components/ui/field';
import { Card, CardContent, CardHeader } from '../../components/ui/surfaces';
import { formatBeijing, toBeijingDayjs } from '../../lib/beijingTime';
import { ApiError } from '../../lib/http';
import { AccountLayout } from './account-layout';

function failureMessage(error: unknown) {
  return error instanceof ApiError ? error.message : '操作失败，请稍后再试';
}
function ProfileForm() {
  const { runtime, identity, announce } = useAuth();
  const auth = useIdentity();
  const user = auth.status === 'authenticated' ? auth.identity.user : undefined;
  const [name, setName] = useState(user?.real_name ?? '');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    if ([...name].length > 100) {
      setError('姓名最多100个字符');
      return;
    }
    setPending(true);
    setError('');
    try {
      await runtime.auth.updateProfile({ real_name: name });
      announce('个人资料已保存');
      await identity.refresh();
    } catch (failure) {
      setError(failureMessage(failure));
    } finally {
      setPending(false);
    }
  }
  return (
    <Card>
      <CardHeader title="个人资料" description="更新工作台显示的姓名。" />
      <CardContent>
        <form
          className="max-w-lg space-y-5"
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <Field label="用户名">
            {(control) => (
              <Input {...control} value={user?.username ?? ''} disabled />
            )}
          </Field>
          <Field label="姓名" error={error || undefined}>
            {(control) => (
              <Input
                {...control}
                name="real_name"
                autoComplete="name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                disabled={pending}
              />
            )}
          </Field>
          <Button type="submit" pending={pending}>
            保存资料
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
function PasswordForm() {
  const { runtime, identity, announce } = useAuth();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [revoke, setRevoke] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const parsed = changePasswordRequestSchema.safeParse({
      oldPassword,
      newPassword,
      revokeOtherSessions: revoke,
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join('；'));
      return;
    }
    if (newPassword !== confirmation) {
      setError('两次输入的新密码不一致');
      return;
    }
    setPending(true);
    setError('');
    try {
      const result = await runtime.auth.changePassword(parsed.data);
      setOldPassword('');
      setNewPassword('');
      setConfirmation('');
      announce(result.message || '密码已修改');
      await identity.refresh();
    } catch (failure) {
      setError(failureMessage(failure));
    } finally {
      setPending(false);
    }
  }
  return (
    <Card>
      <CardHeader
        title="修改密码"
        description="至少8位，包含字母和数字，不使用近期密码。"
      />
      <CardContent>
        <form
          className="max-w-lg space-y-5"
          onSubmit={(event) => {
            void submit(event);
          }}
        >
          <Field label="原密码" required>
            {(control) => (
              <Input
                {...control}
                name="oldPassword"
                autoComplete="current-password"
                type="password"
                maxLength={1024}
                value={oldPassword}
                onChange={(event) => setOldPassword(event.target.value)}
                disabled={pending}
              />
            )}
          </Field>
          <Field label="新密码" required>
            {(control) => (
              <Input
                {...control}
                name="newPassword"
                autoComplete="new-password"
                type="password"
                maxLength={1024}
                value={newPassword}
                onChange={(event) => setNewPassword(event.target.value)}
                disabled={pending}
              />
            )}
          </Field>
          <Field label="确认新密码" required>
            {(control) => (
              <Input
                {...control}
                name="confirmation"
                autoComplete="new-password"
                type="password"
                maxLength={1024}
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                disabled={pending}
              />
            )}
          </Field>
          <label className="flex min-h-10 items-center gap-3 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-ink"
              checked={revoke}
              onChange={(event) => setRevoke(event.target.checked)}
              disabled={pending}
            />
            同时退出其他登录设备
          </label>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button type="submit" pending={pending}>
            更新密码
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
function SessionList() {
  const { runtime, identity, announce } = useAuth();
  const auth = useIdentity();
  const current = auth.status === 'authenticated' ? auth.identity : undefined;
  const [revoking, setRevoking] = useState<string>();
  const [error, setError] = useState('');
  const query = useQuery({
    queryKey: [
      'auth',
      'sessions',
      current?.user.id,
      current?.sessionId,
      runtime.session.revision,
    ],
    queryFn: ({ signal }) => runtime.auth.sessions(signal),
    enabled: Boolean(current),
    retry: false,
  });
  async function revoke(id: string) {
    if (revoking) return;
    setRevoking(id);
    setError('');
    try {
      await runtime.auth.revokeSession(id);
      if (id === current?.sessionId) {
        runtime.reset();
        announce('当前登录已退出');
      } else {
        announce('登录会话已撤销');
        await query.refetch();
      }
    } catch (failure) {
      setError(failureMessage(failure));
      if (failure instanceof ApiError && failure.status === 403)
        await identity.refresh();
    } finally {
      setRevoking(undefined);
    }
  }
  const rows = query.data?.data;
  return (
    <Card>
      <CardHeader
        title="登录设备"
        description="时间统一显示为北京时间（UTC+8）。撤销当前会话会退出登录。"
        action={
          <Button
            size="small"
            variant="secondary"
            pending={query.isFetching}
            onClick={() => {
              void query.refetch();
            }}
          >
            刷新
          </Button>
        }
      />
      <CardContent>
        {query.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            正在读取登录会话…
          </p>
        ) : query.isError ? (
          <p role="alert" className="text-sm text-destructive">
            会话列表加载失败，请刷新重试。
          </p>
        ) : !rows?.length ? (
          <p className="text-sm text-muted-foreground">暂无登录会话。</p>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((row) => {
              const active =
                row.status === 'ACTIVE' &&
                (!row.expires_at ||
                  toBeijingDayjs(row.expires_at).valueOf() > Date.now());
              return (
                <li
                  key={row.id}
                  className="flex flex-wrap items-start justify-between gap-4 py-5 first:pt-0"
                >
                  <div className="min-w-0 flex-1 basis-60">
                    <div className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                      <span className="break-all">
                        {row.user_agent || '未知设备'}
                      </span>
                      {row.id === current?.sessionId && (
                        <span className="rounded-pill bg-signal-soft px-2 py-1 text-xs text-ink">
                          当前会话
                        </span>
                      )}
                    </div>
                    <p className="mt-2 font-mono text-xs text-muted-foreground">
                      {row.ip_address || '未知地址'}
                    </p>
                    <p className="mt-2 text-xs leading-6 text-muted-foreground">
                      最近活动：
                      {row.last_active_at
                        ? formatBeijing(row.last_active_at)
                        : '未知'}
                      <br />
                      到期时间：
                      {row.expires_at ? formatBeijing(row.expires_at) : '未知'}
                    </p>
                  </div>
                  {active ? (
                    <Button
                      variant="secondary"
                      size="small"
                      pending={revoking === row.id}
                      disabled={Boolean(revoking)}
                      onClick={() => {
                        void revoke(row.id);
                      }}
                    >
                      {row.id === current?.sessionId
                        ? '退出当前会话'
                        : '撤销会话'}
                    </Button>
                  ) : (
                    <span className="rounded-pill bg-muted px-3 py-1 text-xs text-muted-foreground">
                      {row.status === 'REVOKED'
                        ? '已撤销'
                        : row.status === 'ACTIVE'
                        ? '已过期'
                        : '不可用'}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {error && (
          <p role="alert" className="mt-4 text-sm text-destructive">
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
export default function ProfilePage() {
  const navigate = useNavigate();
  const auth = useIdentity();
  const forced = createAccess(
    auth.status === 'authenticated' ? auth.identity : undefined,
  ).mustChangePassword;
  const search = useRouterState({
    select: (state) => state.location.searchStr,
  });
  const initial = new URLSearchParams(search).get('tab');
  const tab = ['profile', 'password', 'sessions'].includes(initial ?? '')
    ? initial
    : forced
    ? 'password'
    : 'profile';
  const tabs = [
    { id: 'profile', name: '个人资料' },
    { id: 'password', name: '修改密码' },
    { id: 'sessions', name: '登录设备' },
  ];
  return (
    <AccountLayout title="个人中心">
      {forced && (
        <div
          role="alert"
          className="mb-6 rounded-panel border border-status-warning bg-status-warning-soft p-5 text-sm leading-6"
        >
          请先修改密码，再继续使用工作台其他功能。
        </div>
      )}
      <div className="mb-6 flex flex-wrap gap-2" aria-label="个人中心功能">
        {tabs.map((item) => (
          <Button
            key={item.id}
            variant={tab === item.id ? 'primary' : 'secondary'}
            aria-pressed={tab === item.id}
            onClick={() => {
              void navigate(routerDestination(`/profile?tab=${item.id}`));
            }}
          >
            {item.name}
          </Button>
        ))}
      </div>
      {tab === 'password' ? (
        <PasswordForm />
      ) : tab === 'sessions' ? (
        <SessionList />
      ) : (
        <ProfileForm />
      )}
    </AccountLayout>
  );
}
