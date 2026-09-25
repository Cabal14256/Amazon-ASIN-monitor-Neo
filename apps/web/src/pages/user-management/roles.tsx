import { RefreshCw, ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { EmptyState, Skeleton } from '../../components/ui/feedback';
import { Card, CardContent, CardHeader } from '../../components/ui/surfaces';
import { useManagement } from './context';
import { managementError, managementTime } from './management-data';
import { ManagementFailure } from './management-feedback';
import { useSensitiveQuery } from './use-sensitive-query';

export function RolePanel() {
  const { api, access, afterWrite } = useManagement();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [selectedPermissionIds, setSelectedPermissionIds] = useState<
    string[] | null
  >(null);
  const [confirmAdmin, setConfirmAdmin] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const roles = useSensitiveQuery(
    ['management', 'roles'],
    (signal) => api.roles(signal),
    access.canReadRole,
  );
  const detail = useSensitiveQuery(
    ['management', 'role', selectedId],
    (signal) => api.role(selectedId!, signal),
    Boolean(selectedId) && access.canReadRole,
  );
  const permissions = useSensitiveQuery(
    ['management', 'role-permissions'],
    (signal) => api.permissions(signal),
    editing && access.canReadRole,
  );
  const groups = Object.entries(permissions.data?.grouped ?? {}).sort(
    ([a], [b]) => a.localeCompare(b, 'zh-CN'),
  );

  function open(roleId: string) {
    if (saving || preparing) return;
    setSelectedId(roleId);
    setEditing(false);
    setSelectedPermissionIds(null);
    setSaveError(null);
    setConfirmAdmin(false);
  }
  function close() {
    setSelectedId(null);
    setEditing(false);
    setSelectedPermissionIds(null);
    setSaveError(null);
  }
  async function beginEdit() {
    if (!selectedId || !access.canWriteRole || preparing) return;
    setPreparing(true);
    setSaveError(null);
    try {
      const [freshRole, freshPermissions] = await Promise.all([
        detail.query.refetch(),
        permissions.query.refetch(),
      ]);
      if (
        !freshRole.isSuccess ||
        !freshRole.data ||
        !freshPermissions.isSuccess
      )
        throw freshRole.error ?? freshPermissions.error;
      setSelectedPermissionIds(
        freshRole.data.value.permissions?.map((permission) => permission.id) ??
          [],
      );
      setConfirmAdmin(false);
      setEditing(true);
    } catch (error) {
      setSaveError(managementError(error));
    } finally {
      setPreparing(false);
    }
  }
  async function save() {
    if (!selectedId || !detail.data || !selectedPermissionIds) return;
    if (!access.canWriteRole) return;
    if (detail.data.code === 'ADMIN' && !confirmAdmin) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api.assignPermissions(selectedId, {
        permissionIds: selectedPermissionIds,
      });
      await afterWrite('角色权限已更新，当前身份与权限已重新验证。', true);
      close();
    } catch (error) {
      setSaveError(managementError(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div role="tabpanel" aria-label="角色管理" className="space-y-6">
      <Card>
        <CardHeader
          title="角色列表"
          description="角色权限以服务器当前读取结果为准。"
          action={
            <Button
              variant="secondary"
              size="small"
              pending={roles.query.isFetching}
              onClick={() => void roles.query.refetch()}
            >
              <RefreshCw aria-hidden="true" />
              刷新
            </Button>
          }
        />
        <CardContent className="space-y-4">
          {roles.query.isPending && <Skeleton className="h-32" />}
          {!roles.data && roles.error && (
            <ManagementFailure
              error={roles.error}
              retry={() => void roles.query.refetch()}
            />
          )}
          {roles.data?.length === 0 && (
            <EmptyState
              title="暂无角色"
              description="当前用户系统尚未配置角色。"
            />
          )}
          {roles.data && roles.data.length > 0 && (
            <div className="grid gap-3 lg:grid-cols-2">
              {roles.data.map((role) => (
                <article
                  key={role.id}
                  className="rounded-control border border-border p-4"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="font-semibold">{role.name}</h3>
                      <p className="neo-mono mt-1 text-xs text-muted-foreground">
                        {role.code}
                      </p>
                    </div>
                    <ShieldCheck
                      aria-hidden="true"
                      className="size-5 text-muted-foreground"
                    />
                  </div>
                  {role.description && (
                    <p className="mt-3 text-sm text-muted-foreground">
                      {role.description}
                    </p>
                  )}
                  <p className="mt-3 text-xs text-muted-foreground">
                    {role.permissions?.length ?? 0} 项权限 · 创建于{' '}
                    {managementTime(role.create_time)}
                  </p>
                  <Button
                    variant="secondary"
                    size="small"
                    className="mt-4"
                    disabled={saving || preparing}
                    onClick={() => open(role.id)}
                  >
                    查看权限
                  </Button>
                </article>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      {selectedId && (
        <Card key={selectedId}>
          <CardHeader
            title={detail.data ? `${detail.data.name} · 角色详情` : '角色详情'}
            description="编辑前从服务器重新读取角色与权限清单。"
            action={
              <Button
                variant="ghost"
                size="small"
                disabled={saving || preparing}
                onClick={close}
              >
                关闭
              </Button>
            }
          />
          <CardContent className="space-y-5">
            {detail.query.isPending && <Skeleton className="h-24" />}
            {!detail.data && detail.error && (
              <ManagementFailure
                error={detail.error}
                retry={() => void detail.query.refetch()}
              />
            )}
            {detail.data && !editing && (
              <>
                <p className="text-sm text-muted-foreground">
                  {detail.data.permissions?.length ?? 0} 项权限 · 更新于{' '}
                  {managementTime(detail.data.update_time)}
                </p>
                <div className="flex flex-wrap gap-2">
                  {(detail.data.permissions ?? []).map((permission) => (
                    <span
                      key={permission.id}
                      className="rounded-pill bg-muted px-3 py-1.5 text-xs"
                      title={permission.code}
                    >
                      {permission.name}
                    </span>
                  ))}
                  {!detail.data.permissions?.length && (
                    <p className="text-sm text-muted-foreground">暂无权限。</p>
                  )}
                </div>
                {access.canWriteRole && (
                  <Button pending={preparing} onClick={() => void beginEdit()}>
                    编辑权限
                  </Button>
                )}
                {saveError && (
                  <p role="alert" className="text-sm text-status-danger">
                    {saveError}
                  </p>
                )}
              </>
            )}
            {detail.data && editing && (
              <>
                {permissions.query.isPending && <Skeleton className="h-32" />}
                {!permissions.data && permissions.error && (
                  <ManagementFailure
                    error={permissions.error}
                    retry={() => void permissions.query.refetch()}
                  />
                )}
                {permissions.data && selectedPermissionIds && (
                  <>
                    {groups.map(([resource, options]) => (
                      <fieldset
                        key={resource}
                        className="rounded-control border border-border p-4"
                      >
                        <legend className="px-1 text-sm font-semibold">
                          {resource || '其他'}
                        </legend>
                        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                          {options.map((permission) => (
                            <label
                              key={permission.id}
                              className="flex items-start gap-2 text-sm"
                            >
                              <input
                                type="checkbox"
                                checked={selectedPermissionIds.includes(
                                  permission.id,
                                )}
                                onChange={(event) =>
                                  setSelectedPermissionIds((previous) =>
                                    event.target.checked
                                      ? [...(previous ?? []), permission.id]
                                      : (previous ?? []).filter(
                                          (id) => id !== permission.id,
                                        ),
                                  )
                                }
                              />
                              <span>
                                {permission.name}
                                <span className="neo-mono block text-xs text-muted-foreground">
                                  {permission.code}
                                </span>
                              </span>
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    ))}
                    {detail.data.code === 'ADMIN' && (
                      <label className="flex items-start gap-2 rounded-control bg-status-warning-soft p-4 text-sm text-status-warning">
                        <input
                          type="checkbox"
                          checked={confirmAdmin}
                          onChange={(event) =>
                            setConfirmAdmin(event.target.checked)
                          }
                        />
                        <span>
                          我确认正在修改 ADMIN
                          角色；保存后可能立即失去当前账号的管理权限。
                        </span>
                      </label>
                    )}
                    {saveError && (
                      <p role="alert" className="text-sm text-status-danger">
                        {saveError}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        pending={saving}
                        disabled={detail.data.code === 'ADMIN' && !confirmAdmin}
                        onClick={() => void save()}
                      >
                        保存权限
                      </Button>
                      <Button
                        variant="secondary"
                        disabled={saving}
                        onClick={() => {
                          setEditing(false);
                          setSaveError(null);
                        }}
                      >
                        取消
                      </Button>
                    </div>
                  </>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
