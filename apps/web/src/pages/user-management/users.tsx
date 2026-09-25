import type {
  UserDetailData,
  UserListItem,
  UserListQuery,
} from '@asin-monitor/contracts';
import {
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Search,
  UserPlus,
} from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/button';
import {
  EmptyState,
  Skeleton,
  StatusBadge,
} from '../../components/ui/feedback';
import { Field, Input } from '../../components/ui/field';
import { Card, CardContent, CardHeader } from '../../components/ui/surfaces';
import { useManagement } from './context';
import {
  canAdminResetPassword,
  managementTime,
  managementWriteError,
  USER_STATUSES,
} from './management-data';
import { ManagementFailure } from './management-feedback';
import { useSensitiveQuery } from './use-sensitive-query';
import { ResetPasswordForm, UserEditor } from './user-forms';

const PAGE_SIZES = [10, 20, 50, 100] as const;
const INITIAL_QUERY: UserListQuery = { current: 1, pageSize: 10 };
type Editor = 'create' | 'edit' | 'reset' | null;

function UserRows({
  rows,
  selectedIds,
  toggle,
  open,
  canDelete,
  currentUserId,
}: {
  rows: UserListItem[];
  selectedIds: string[];
  toggle: (id: string) => void;
  open: (id: string) => void;
  canDelete: boolean;
  currentUserId: string | null;
}) {
  return (
    <>
      <div className="grid gap-3 lg:hidden">
        {rows.map((row) => (
          <article
            key={row.id}
            className="rounded-control border border-border p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="font-semibold">{row.username}</h3>
                <p className="text-xs text-muted-foreground">
                  {row.real_name || '未填写姓名'}
                </p>
              </div>
              <StatusBadge status={USER_STATUSES[row.status].badge}>
                {USER_STATUSES[row.status].label}
              </StatusBadge>
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              角色：{row.roles?.map((role) => role.name).join('、') || '未分配'}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              最近登录：{managementTime(row.last_login_time)}
            </p>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {canDelete && row.id !== currentUserId && (
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(row.id)}
                    onChange={() => toggle(row.id)}
                  />
                  选择删除
                </label>
              )}
              <Button
                variant="secondary"
                size="small"
                onClick={() => open(row.id)}
              >
                查看详情
              </Button>
            </div>
          </article>
        ))}
      </div>
      <div className="hidden overflow-x-auto lg:block">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border text-xs text-muted-foreground">
            <tr>
              {canDelete && <th className="p-3">选择</th>}
              <th className="p-3">用户名 / 姓名</th>
              <th className="p-3">状态</th>
              <th className="p-3">角色</th>
              <th className="p-3">最近登录</th>
              <th className="p-3">创建时间</th>
              <th className="p-3">操作</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-border last:border-0">
                {canDelete && (
                  <td className="p-3">
                    {row.id !== currentUserId && (
                      <input
                        type="checkbox"
                        aria-label={`选择 ${row.username}`}
                        checked={selectedIds.includes(row.id)}
                        onChange={() => toggle(row.id)}
                      />
                    )}
                  </td>
                )}
                <td className="p-3">
                  <span className="font-medium">{row.username}</span>
                  <span className="block text-xs text-muted-foreground">
                    {row.real_name || '未填写姓名'}
                  </span>
                </td>
                <td className="p-3">
                  <StatusBadge status={USER_STATUSES[row.status].badge}>
                    {USER_STATUSES[row.status].label}
                  </StatusBadge>
                </td>
                <td className="max-w-48 p-3 text-xs">
                  {row.roles?.map((role) => role.name).join('、') || '未分配'}
                </td>
                <td className="neo-mono whitespace-nowrap p-3 text-xs">
                  {managementTime(row.last_login_time)}
                </td>
                <td className="neo-mono whitespace-nowrap p-3 text-xs">
                  {managementTime(row.create_time)}
                </td>
                <td className="p-3">
                  <Button
                    variant="secondary"
                    size="small"
                    onClick={() => open(row.id)}
                  >
                    详情
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function UserPanel() {
  const { api, access, currentUserId, afterWrite, reportAccessDenied } =
    useManagement();
  const [username, setUsername] = useState('');
  const [status, setStatus] = useState('');
  const [queryInputError, setQueryInputError] = useState<string | null>(null);
  const [query, setQuery] = useState<UserListQuery>(INITIAL_QUERY);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [editor, setEditor] = useState<Editor>(null);
  const [editingUser, setEditingUser] = useState<UserDetailData | null>(null);
  const [preparingEdit, setPreparingEdit] = useState(false);
  const [deleteIds, setDeleteIds] = useState<string[] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteResult, setDeleteResult] = useState<string | null>(null);
  const users = useSensitiveQuery(
    ['management', 'users', query],
    (signal) => api.users(query, signal),
    access.canReadUser,
  );
  const detail = useSensitiveQuery(
    ['management', 'user', selectedId],
    (signal) => api.user(selectedId!, signal),
    Boolean(selectedId) && access.canReadUser,
  );
  useEffect(() => {
    if (
      selectedId &&
      users.data &&
      !users.data.list.some((row) => row.id === selectedId)
    ) {
      selectedIdRef.current = null;
      setSelectedId(null);
      setEditingUser(null);
      setEditor(null);
    }
  }, [selectedId, users.data]);
  const currentPage = query.current ?? 1;
  const pageSize = query.pageSize ?? 10;
  const pageCount = users.data
    ? Math.max(1, Math.ceil(users.data.total / pageSize))
    : 1;

  function changeQuery(next: UserListQuery) {
    setQuery(next);
    selectedIdRef.current = null;
    setSelectedId(null);
    setEditingUser(null);
    setSelectedIds([]);
    setEditor(null);
    setDeleteIds(null);
    setDeleteResult(null);
  }
  function selectUser(id: string | null) {
    selectedIdRef.current = id;
    setSelectedId(id);
    setEditingUser(null);
    setEditor(null);
  }
  async function openEditor() {
    const userId = selectedIdRef.current;
    if (!userId || preparingEdit) return;
    setPreparingEdit(true);
    try {
      const refreshed = await detail.query.refetch();
      if (
        selectedIdRef.current === userId &&
        refreshed.isSuccess &&
        refreshed.data?.value.id === userId
      ) {
        setEditingUser(refreshed.data.value);
        setEditor('edit');
      }
    } finally {
      setPreparingEdit(false);
    }
  }
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      username.length > 200 ||
      [...username].some((char) => {
        const code = char.charCodeAt(0);
        return code <= 31 || code === 127;
      })
    ) {
      setQueryInputError('用户名筛选条件无效。');
      return;
    }
    setQueryInputError(null);
    changeQuery({
      username: username.trim() || undefined,
      status: status
        ? (status as NonNullable<UserListQuery['status']>)
        : undefined,
      current: 1,
      pageSize,
    });
  }
  function toggle(id: string) {
    setSelectedIds((previous) =>
      previous.includes(id)
        ? previous.filter((value) => value !== id)
        : [...previous, id],
    );
  }
  async function confirmDelete() {
    if (!deleteIds?.length || !access.canDeleteUser || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      if (deleteIds.length === 1) {
        await api.deleteUser(deleteIds[0]);
        setDeleteResult('已删除 1 个用户。');
        await afterWrite('用户已删除。');
      } else {
        const result = await api.batchDelete({
          userIds: deleteIds as [string, ...string[]],
        });
        const details = [
          ...result.skipped.map((item) => `${item.userId}：${item.reason}`),
          ...result.failed.map((item) => `${item.userId}：${item.message}`),
        ];
        const summary = `批量删除：成功 ${result.deletedCount}，跳过 ${result.skipped.length}，失败 ${result.failed.length}。`;
        setDeleteResult(
          details.length > 0
            ? `${summary} ${details.slice(0, 10).join('；')}${
                details.length > 10 ? `；另有 ${details.length - 10} 项` : ''
              }`
            : summary,
        );
        if (result.deletedCount > 0) await afterWrite(summary);
      }
      setSelectedIds([]);
      selectUser(null);
      setEditor(null);
      setDeleteIds(null);
    } catch (error) {
      setDeleteError(managementWriteError(error, reportAccessDenied));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div role="tabpanel" aria-label="用户管理" className="space-y-6">
      <Card>
        <CardHeader title="筛选用户" description="筛选与分页由服务器执行。" />
        <CardContent>
          <form onSubmit={apply} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="用户名">
                {(control) => (
                  <Input
                    {...control}
                    value={username}
                    maxLength={200}
                    onChange={(event) => setUsername(event.target.value)}
                  />
                )}
              </Field>
              <Field label="状态">
                {(control) => (
                  <select
                    {...control}
                    className="w-full rounded-input border border-input bg-card px-4 py-3 text-sm"
                    value={status}
                    onChange={(event) => setStatus(event.target.value)}
                  >
                    <option value="">全部状态</option>
                    {Object.entries(USER_STATUSES).map(([value, meta]) => (
                      <option key={value} value={value}>
                        {meta.label}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
            {queryInputError && (
              <p role="alert" className="text-sm text-status-danger">
                {queryInputError}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="submit">
                <Search aria-hidden="true" />
                查询
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setUsername('');
                  setStatus('');
                  setQueryInputError(null);
                  changeQuery(INITIAL_QUERY);
                }}
              >
                清空筛选
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
      <Card>
        <CardHeader
          title="用户列表"
          description={
            users.data
              ? `第 ${currentPage} 页 · 共 ${users.data.total} 人`
              : '仅展示当前账号有权读取的用户'
          }
          action={
            <div className="flex flex-wrap gap-2">
              {access.canWriteUser && access.canReadRole && (
                <Button
                  size="small"
                  onClick={() => {
                    selectUser(null);
                    setEditor('create');
                  }}
                >
                  <UserPlus aria-hidden="true" />
                  新建用户
                </Button>
              )}
              <Button
                variant="secondary"
                size="small"
                pending={users.query.isFetching}
                onClick={() => void users.query.refetch()}
              >
                <RefreshCw aria-hidden="true" />
                刷新
              </Button>
            </div>
          }
        />
        <CardContent className="space-y-5">
          {users.query.isPending && <Skeleton className="h-32" />}
          {!users.data && users.error && (
            <ManagementFailure
              error={users.error}
              retry={() => void users.query.refetch()}
            />
          )}
          {users.data?.list.length === 0 && (
            <EmptyState
              title="暂无匹配用户"
              description="请调整用户名或状态筛选。"
            />
          )}
          {users.data && users.data.list.length > 0 && (
            <>
              <UserRows
                rows={users.data.list}
                selectedIds={selectedIds}
                toggle={toggle}
                open={(id) => {
                  selectUser(id);
                  setDeleteIds(null);
                }}
                canDelete={access.canDeleteUser}
                currentUserId={currentUserId}
              />
              {access.canDeleteUser && selectedIds.length > 0 && (
                <Button
                  variant="destructive"
                  size="small"
                  onClick={() => setDeleteIds([...selectedIds])}
                >
                  删除所选 {selectedIds.length} 人
                </Button>
              )}
            </>
          )}
          {users.data && (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4 text-sm">
              <span className="text-muted-foreground">
                第 {currentPage} / {pageCount} 页
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 text-xs">
                  每页
                  <select
                    aria-label="每页数量"
                    className="rounded-control border border-input bg-card px-3 py-2"
                    value={pageSize}
                    onChange={(event) =>
                      changeQuery({
                        ...query,
                        current: 1,
                        pageSize: Number(event.target.value),
                      })
                    }
                  >
                    {PAGE_SIZES.map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  variant="secondary"
                  size="small"
                  disabled={currentPage <= 1}
                  onClick={() =>
                    changeQuery({ ...query, current: currentPage - 1 })
                  }
                >
                  <ChevronLeft aria-hidden="true" />
                  上一页
                </Button>
                <Button
                  variant="secondary"
                  size="small"
                  disabled={currentPage >= pageCount}
                  onClick={() =>
                    changeQuery({ ...query, current: currentPage + 1 })
                  }
                >
                  下一页
                  <ChevronRight aria-hidden="true" />
                </Button>
              </div>
            </div>
          )}
          {deleteResult && (
            <p
              role="status"
              className="rounded-control bg-status-info-soft p-3 text-sm text-status-info"
            >
              {deleteResult}
            </p>
          )}
        </CardContent>
      </Card>
      {selectedId && !editor && (
        <Card key={selectedId} aria-label="用户详情">
          <CardHeader
            title={
              detail.data ? `用户详情 · ${detail.data.username}` : '用户详情'
            }
            action={
              <Button
                variant="ghost"
                size="small"
                onClick={() => selectUser(null)}
              >
                关闭
              </Button>
            }
          />
          <CardContent className="space-y-5">
            {detail.query.isPending && <Skeleton className="h-28" />}
            {!detail.data && detail.error && (
              <ManagementFailure
                error={detail.error}
                retry={() => void detail.query.refetch()}
              />
            )}
            {detail.data && (
              <>
                <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
                  {(
                    [
                      ['用户名', detail.data.username],
                      ['真实姓名', detail.data.real_name || '未填写'],
                      ['状态', USER_STATUSES[detail.data.status].label],
                      ['最近登录', managementTime(detail.data.last_login_time)],
                      ['最近登录 IP', detail.data.last_login_ip || '未记录'],
                      ['创建时间', managementTime(detail.data.create_time)],
                      [
                        '密码到期',
                        managementTime(detail.data.password_expires_at),
                      ],
                      [
                        '强制改密',
                        detail.data.force_password_change ? '是' : '否',
                      ],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd className="mt-1 break-all">{value}</dd>
                    </div>
                  ))}
                </dl>
                <section>
                  <h3 className="font-semibold">角色与权限</h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    角色：
                    {detail.data.roles?.map((role) => role.name).join('、') ||
                      '未分配'}
                  </p>
                  <p className="mt-1 break-all text-xs text-muted-foreground">
                    权限：{detail.data.permissions?.join('、') || '无'}
                  </p>
                </section>
                {detail.data.statusHistory &&
                  detail.data.statusHistory.length > 0 && (
                    <section>
                      <h3 className="font-semibold">状态历史</h3>
                      <ol className="mt-3 space-y-2">
                        {detail.data.statusHistory.map((item, index) => (
                          <li
                            key={item.id ?? index}
                            className="rounded-control bg-muted p-3 text-sm"
                          >
                            {item.old_status || '初始'} →{' '}
                            {item.new_status || '未知'} ·{' '}
                            {managementTime(
                              item.created_at ?? item.create_time,
                            )}
                            {item.reason && (
                              <span className="block">原因：{item.reason}</span>
                            )}
                          </li>
                        ))}
                      </ol>
                    </section>
                  )}
                <div className="flex flex-wrap gap-2">
                  {access.canWriteUser && (
                    <>
                      <Button
                        pending={preparingEdit}
                        onClick={() => void openEditor()}
                      >
                        编辑用户
                      </Button>
                      {canAdminResetPassword(selectedId, currentUserId) && (
                        <Button
                          variant="secondary"
                          onClick={() => setEditor('reset')}
                        >
                          重置密码
                        </Button>
                      )}
                    </>
                  )}
                  {access.canDeleteUser && selectedId !== currentUserId && (
                    <Button
                      variant="destructive"
                      onClick={() => setDeleteIds([selectedId])}
                    >
                      删除用户
                    </Button>
                  )}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
      {editor === 'create' && (
        <UserEditor key="create" close={() => setEditor(null)} />
      )}
      {editor === 'edit' && editingUser && (
        <UserEditor
          key={`edit-${editingUser.id}`}
          user={editingUser}
          close={() => {
            setEditingUser(null);
            setEditor(null);
          }}
        />
      )}
      {editor === 'reset' && detail.data && (
        <ResetPasswordForm
          key={`reset-${detail.data.id}`}
          user={detail.data}
          close={() => setEditor(null)}
        />
      )}
      {deleteIds && (
        <Card aria-label="确认删除用户">
          <CardHeader
            title="确认删除用户"
            description={`将删除 ${deleteIds.length} 个用户；不可删除的记录由服务器逐项返回。`}
          />
          <CardContent className="space-y-4">
            <p className="break-all text-sm text-muted-foreground">
              {deleteIds.join('、')}
            </p>
            {deleteError && (
              <p role="alert" className="text-sm text-status-danger">
                {deleteError}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="destructive"
                pending={deleting}
                onClick={() => void confirmDelete()}
              >
                确认删除
              </Button>
              <Button
                variant="secondary"
                disabled={deleting}
                onClick={() => setDeleteIds(null)}
              >
                取消
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
