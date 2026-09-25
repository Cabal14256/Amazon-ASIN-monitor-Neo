import {
  createUserRequestSchema,
  updateUserRequestSchema,
  type Role,
  type UserDetailData,
} from '@asin-monitor/contracts';
import { useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/button';
import { Skeleton } from '../../components/ui/feedback';
import { Field, Input, Textarea } from '../../components/ui/field';
import { Card, CardContent, CardHeader } from '../../components/ui/surfaces';
import { useManagement } from './context';
import {
  canAdminResetPassword,
  managementWriteError,
  parseAdminResetForm,
  USER_STATUSES,
} from './management-data';
import { ManagementFailure } from './management-feedback';
import { useSensitiveQuery } from './use-sensitive-query';

function RoleOptions({
  selected,
  change,
  roles,
  loading,
  error,
  retry,
}: {
  selected: string[];
  change: (value: string[]) => void;
  roles: Role[] | undefined;
  loading: boolean;
  error: unknown;
  retry: () => void;
}) {
  const { access } = useManagement();
  if (!access.canReadRole)
    return (
      <p role="alert" className="text-sm text-status-warning">
        当前账号缺少角色读取权限，无法选择角色或提交用户表单。
      </p>
    );
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-semibold">角色 *</legend>
      {loading && <Skeleton className="h-14" />}
      {!roles && Boolean(error) && (
        <ManagementFailure error={error} retry={retry} />
      )}
      {roles?.length === 0 && (
        <p className="text-sm text-muted-foreground">暂无可分配角色。</p>
      )}
      <div className="flex flex-wrap gap-3">
        {roles?.map((role) => (
          <label
            key={role.id}
            className="inline-flex items-center gap-2 rounded-control border border-border px-3 py-2 text-sm"
          >
            <input
              type="checkbox"
              checked={selected.includes(role.id)}
              onChange={(event) =>
                change(
                  event.target.checked
                    ? [...selected, role.id]
                    : selected.filter((id) => id !== role.id),
                )
              }
            />
            {role.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export function UserEditor({
  user,
  close,
}: {
  user?: UserDetailData;
  close: () => void;
}) {
  const { api, access, currentUserId, afterWrite, reportAccessDenied } =
    useManagement();
  const editing = Boolean(user);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [realName, setRealName] = useState(user?.real_name ?? '');
  const [status, setStatus] = useState<UserDetailData['status']>(
    user?.status ?? 'ACTIVE',
  );
  const [statusReason, setStatusReason] = useState('');
  const [roleIds, setRoleIds] = useState<string[]>(
    user?.roles?.map((role) => role.id) ?? [],
  );
  const [forcePasswordChange, setForcePasswordChange] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const roles = useSensitiveQuery(
    ['management', 'form-roles'],
    (signal) => api.allRoles(signal),
    access.canReadRole,
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!access.canWriteUser || !access.canReadRole || pending) return;
    setError(null);
    if (!roles.data || roles.query.isFetching) {
      setError('请先成功加载可分配角色。');
      return;
    }
    setPending(true);
    try {
      if (editing && user) {
        const input = updateUserRequestSchema.safeParse({
          real_name: realName.trim(),
          status,
          roleIds,
          statusReason: statusReason.trim() || undefined,
        });
        if (!input.success) {
          setError(input.error.issues[0]?.message ?? '请检查用户表单。');
          return;
        }
        await api.updateUser(user.id, input.data);
      } else {
        const input = createUserRequestSchema.safeParse({
          username: username.trim(),
          password,
          real_name: realName.trim() || undefined,
          roleIds,
          forcePasswordChange,
        });
        if (!input.success) {
          setError(input.error.issues[0]?.message ?? '请检查用户表单。');
          return;
        }
        await api.createUser(input.data);
      }
      setPassword('');
      await afterWrite(
        editing ? '用户已更新。' : '用户已创建。',
        editing && user?.id === currentUserId,
      );
      close();
    } catch (cause) {
      setError(managementWriteError(cause, reportAccessDenied));
    } finally {
      setPending(false);
    }
  }

  return (
    <Card aria-label={editing ? '编辑用户' : '新建用户'}>
      <CardHeader
        title={editing ? `编辑用户 · ${user?.username}` : '新建用户'}
        description="角色与状态变更会在保存后重新验证当前访问权限。"
        action={
          <Button
            variant="ghost"
            size="small"
            disabled={pending}
            onClick={close}
          >
            关闭
          </Button>
        }
      />
      <CardContent>
        <form onSubmit={(event) => void submit(event)} className="space-y-5">
          {!editing && (
            <>
              <Field label="用户名" required>
                {(control) => (
                  <Input
                    {...control}
                    value={username}
                    maxLength={50}
                    autoComplete="off"
                    onChange={(event) => setUsername(event.target.value)}
                  />
                )}
              </Field>
              <Field
                label="初始密码"
                required
                hint="至少 8 位，包含字母和数字；不能与用户名相同。"
              >
                {(control) => (
                  <Input
                    {...control}
                    type="password"
                    value={password}
                    autoComplete="new-password"
                    onChange={(event) => setPassword(event.target.value)}
                  />
                )}
              </Field>
            </>
          )}
          <Field label="真实姓名">
            {(control) => (
              <Input
                {...control}
                value={realName}
                maxLength={100}
                onChange={(event) => setRealName(event.target.value)}
              />
            )}
          </Field>
          <RoleOptions
            selected={roleIds}
            change={setRoleIds}
            roles={roles.data}
            loading={roles.query.isPending}
            error={roles.error}
            retry={() => void roles.query.refetch()}
          />
          {editing ? (
            <>
              <Field label="状态" required>
                {(control) => (
                  <select
                    {...control}
                    className="w-full rounded-input border border-input bg-card px-4 py-3 text-sm"
                    value={status}
                    onChange={(event) =>
                      setStatus(event.target.value as UserDetailData['status'])
                    }
                  >
                    {Object.entries(USER_STATUSES).map(([value, meta]) => (
                      <option key={value} value={value}>
                        {meta.label}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label="状态变更原因">
                {(control) => (
                  <Textarea
                    {...control}
                    value={statusReason}
                    maxLength={255}
                    onChange={(event) => setStatusReason(event.target.value)}
                  />
                )}
              </Field>
            </>
          ) : (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={forcePasswordChange}
                onChange={(event) =>
                  setForcePasswordChange(event.target.checked)
                }
              />
              首次登录强制修改密码
            </label>
          )}
          {error && (
            <p role="alert" className="text-sm text-status-danger">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              pending={pending}
              disabled={
                !access.canReadRole ||
                !roles.data ||
                roles.query.isFetching ||
                roleIds.length === 0
              }
            >
              {editing ? '保存用户' : '创建用户'}
            </Button>
            <Button variant="secondary" disabled={pending} onClick={close}>
              取消
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export function ResetPasswordForm({
  user,
  close,
}: {
  user: UserDetailData;
  close: () => void;
}) {
  const { api, access, currentUserId, afterWrite, reportAccessDenied } =
    useManagement();
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [forceChange, setForceChange] = useState(true);
  const [revokeSessions, setRevokeSessions] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!access.canWriteUser || pending) return;
    if (!canAdminResetPassword(user.id, currentUserId)) {
      setError('请到个人中心修改当前账号密码。');
      return;
    }
    const parsed = parseAdminResetForm(
      password,
      confirmPassword,
      forceChange,
      revokeSessions,
    );
    if (!parsed.success) {
      setError(parsed.message);
      return;
    }
    setPending(true);
    setError(null);
    try {
      await api.resetPassword(user.id, parsed.data);
      setPassword('');
      setConfirmPassword('');
      await afterWrite('密码已重置；目标用户会话按所选设置处理。');
      close();
    } catch (cause) {
      setError(managementWriteError(cause, reportAccessDenied));
    } finally {
      setPending(false);
    }
  }
  return (
    <Card aria-label="管理员重置密码">
      <CardHeader
        title={`重置密码 · ${user.username}`}
        description="新密码只提交到受保护的 API，不在页面持久保存。"
        action={
          <Button
            variant="ghost"
            size="small"
            disabled={pending}
            onClick={close}
          >
            关闭
          </Button>
        }
      />
      <CardContent>
        <form onSubmit={(event) => void submit(event)} className="space-y-5">
          <Field label="新密码" required hint="至少 8 位，包含字母和数字。">
            {(control) => (
              <Input
                {...control}
                type="password"
                value={password}
                autoComplete="new-password"
                onChange={(event) => setPassword(event.target.value)}
              />
            )}
          </Field>
          <Field label="确认新密码" required>
            {(control) => (
              <Input
                {...control}
                type="password"
                value={confirmPassword}
                autoComplete="new-password"
                onChange={(event) => setConfirmPassword(event.target.value)}
              />
            )}
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={forceChange}
              onChange={(event) => setForceChange(event.target.checked)}
            />
            下次登录强制修改密码
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={revokeSessions}
              onChange={(event) => setRevokeSessions(event.target.checked)}
            />
            撤销该用户的所有会话
          </label>
          {error && (
            <p role="alert" className="text-sm text-status-danger">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" pending={pending}>
              确认重置
            </Button>
            <Button variant="secondary" disabled={pending} onClick={close}>
              取消
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
