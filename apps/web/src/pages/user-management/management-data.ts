import {
  adminResetPasswordRequestSchema,
  type AdminResetPasswordRequest,
  type UpdateUserRequest,
  type UserDetailData,
  type UserPublic,
} from '@asin-monitor/contracts';
import { formatBeijing } from '../../lib/beijingTime';
import { ApiError } from '../../lib/http';

export const USER_STATUSES: Record<
  UserPublic['status'],
  { label: string; badge: 'success' | 'warning' | 'danger' | 'unknown' }
> = {
  ACTIVE: { label: '启用', badge: 'success' },
  INACTIVE: { label: '停用', badge: 'unknown' },
  LOCKED: { label: '锁定', badge: 'warning' },
  SUSPENDED: { label: '暂停', badge: 'danger' },
  PENDING: { label: '待激活', badge: 'unknown' },
};

const VALIDATION_MESSAGES = new Map([
  ['用户名已存在', '用户名已存在，请更换用户名。'],
  ['新密码不能与当前密码相同', '新密码不能与当前密码相同。'],
  [
    '新密码不能与最近 5 次使用过的密码相同',
    '新密码不能与最近 5 次使用过的密码相同。',
  ],
  ['密码不能与用户名相同', '密码不能与用户名相同。'],
  [
    '系统至少需要保留一个启用中的管理员账户',
    '系统至少需要保留一个启用中的管理员账户。',
  ],
  ['不能移除自己当前账户的管理员角色', '当前账号不能移除自己的管理员角色。'],
  ['不能禁用、锁定或停用自己的账户', '当前账号不能禁用、锁定或停用自己。'],
  ['包含无效角色ID', '角色已变更，请刷新角色列表后重试。'],
  ['包含无效权限ID', '权限已变更，请刷新权限清单后重试。'],
  ['请至少保留一个角色', '请至少保留一个角色。'],
]);

export function statusForManagedUser(
  targetUserId: string,
  currentUserId: string | null,
  chosenStatus: UserPublic['status'],
): UserPublic['status'] {
  return currentUserId !== null && targetUserId === currentUserId
    ? 'ACTIVE'
    : chosenStatus;
}

export function changedUserUpdate(
  user: UserDetailData,
  currentUserId: string | null,
  values: {
    realName: string;
    status: UserPublic['status'];
    statusReason: string;
    roleIds: string[];
  },
  canReadRole: boolean,
): Omit<UpdateUserRequest, 'roleIds'> & { roleIds?: string[] } {
  const update: Omit<UpdateUserRequest, 'roleIds'> & { roleIds?: string[] } =
    {};
  const realName = values.realName.trim();
  if (realName !== (user.real_name ?? '')) update.real_name = realName;

  const status = statusForManagedUser(user.id, currentUserId, values.status);
  if (status !== user.status) {
    update.status = status;
    const reason = values.statusReason.trim();
    if (reason) update.statusReason = reason;
  }

  if (canReadRole) {
    const previous = new Set(user.roles?.map((role) => role.id) ?? []);
    const next = new Set(values.roleIds);
    if (
      previous.size !== next.size ||
      [...previous].some((id) => !next.has(id))
    )
      update.roleIds = values.roleIds;
  }
  return update;
}

export function managementTime(value: string | null | undefined): string {
  if (!value) return '未记录';
  const formatted = formatBeijing(value, 'YYYY-MM-DD HH:mm:ss');
  return formatted === 'Invalid Date' ? '时间未知' : formatted;
}

export function managementError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === 'INVALID_INPUT') return error.message;
    switch (error.status) {
      case 400:
        return error.message.startsWith('当前角色必须保留权限:')
          ? '该角色必须保留必要权限，请恢复勾选后重试。'
          : VALIDATION_MESSAGES.get(error.message) ??
              '提交内容或筛选条件无效，请检查输入。';
      case 401:
        return '登录状态已失效，请重新登录。';
      case 403:
        return '当前账号没有执行此操作的权限。';
      case 404:
        return '目标记录已不存在，请刷新列表。';
      case 409:
        return '用户名、角色或记录状态发生冲突，请刷新后重试。';
      case 429:
        return '管理请求过于频繁，请稍后重试。';
      case 503:
        return 'Neo 用户权限服务尚未开放，请使用现有入口。';
    }
    if (error.kind === 'INVALID_RESPONSE')
      return '服务器返回的数据不符合用户权限契约，请稍后重试。';
  }
  return '用户权限服务暂不可用，请稍后重试。';
}

export function permissionDenied(error: unknown): error is ApiError {
  return error instanceof ApiError && [401, 403].includes(error.status ?? 0);
}

export function managementWriteError(
  error: unknown,
  reportAccessDenied: () => void,
): string {
  if (permissionDenied(error)) reportAccessDenied();
  return managementError(error);
}

export function canAdminResetPassword(
  targetUserId: string,
  currentUserId: string | null,
): boolean {
  return currentUserId !== null && targetUserId !== currentUserId;
}

export function parseAdminResetForm(
  password: string,
  confirmation: string,
  forceChangeOnNextLogin: boolean,
  revokeAllSessions: boolean,
):
  | { success: true; data: AdminResetPasswordRequest }
  | { success: false; message: string } {
  if (password !== confirmation)
    return { success: false, message: '两次输入的密码不一致。' };
  const parsed = adminResetPasswordRequestSchema.safeParse({
    newPassword: password,
    forceChangeOnNextLogin,
    revokeAllSessions,
  });
  if (!parsed.success)
    return {
      success: false,
      message: parsed.error.issues[0]?.message ?? '密码不符合要求。',
    };
  return { success: true, data: parsed.data };
}

export function visibleManagementData<T>(
  snapshot: { value: T; generation: number } | undefined,
  deniedGeneration: number | null,
  readFailed: boolean,
): T | undefined {
  if (
    readFailed ||
    (deniedGeneration !== null && snapshot?.generation !== deniedGeneration)
  )
    return undefined;
  return snapshot?.value;
}
