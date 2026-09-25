import type { UserPublic } from '@asin-monitor/contracts';
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
        return '提交内容或筛选条件无效，请检查输入。';
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
