import type { NeoAuditLog } from '@asin-monitor/contracts';
import { formatBeijing } from '../../lib/beijingTime';
import { ApiError } from '../../lib/http';

const ACTIONS: Record<string, string> = {
  CREATE: '创建',
  UPDATE: '更新',
  DELETE: '删除',
  READ: '查看',
  LOGIN: '登录',
  LOGOUT: '登出',
  CHANGE_PASSWORD: '修改密码',
  RESET_PASSWORD: '重置密码',
  REVOKE_SESSION: '踢出会话',
  EXPORT: '导出',
  TRIGGER_MONITOR: '触发监控',
  UPDATE_ROLE_PERMISSIONS: '更新角色权限',
};
const RESOURCES: Record<string, string> = {
  variant_group: '变体组',
  asin: 'ASIN',
  user: '用户',
  role: '角色',
  permission: '权限',
  feishu_config: '飞书配置',
  sp_api_config: 'SP-API 配置',
  auth: '认证',
  audit: '审计',
  monitor: '监控',
  monitor_history: '监控历史',
};

export function auditAction(action: string): string {
  return ACTIONS[action] ?? action;
}

export function auditResource(resource: string | null): string {
  return resource ? RESOURCES[resource] ?? resource : '未记录';
}

export function auditTime(value: string | undefined): string {
  if (!value) return '未记录';
  const formatted = formatBeijing(value, 'YYYY-MM-DD HH:mm:ss');
  return formatted === 'Invalid Date' ? '时间未知' : formatted;
}

export function auditResponseStatus(status: NeoAuditLog['responseStatus']): {
  label: string;
  badge: 'success' | 'danger' | 'warning' | 'unknown';
} {
  if (status === null) return { label: '未记录', badge: 'unknown' };
  if (status >= 200 && status < 300)
    return { label: String(status), badge: 'success' };
  if (status >= 400 && status < 500)
    return { label: String(status), badge: 'danger' };
  return { label: String(status), badge: 'warning' };
}

export function auditError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.status) {
      case 400:
        return '筛选或分页参数无效，请检查输入。';
      case 401:
        return '登录状态已失效，请重新登录。';
      case 403:
        return '当前账号没有审计读取权限，请联系管理员。';
      case 404:
        return '这条审计记录已不存在，请刷新列表。';
      case 503:
        return '审计查询繁忙，请稍后重试。';
      case 504:
        return '审计查询超时，请缩小时间范围后重试。';
    }
    if (error.kind === 'INVALID_RESPONSE' && error.message === '服务器响应过大')
      return '审计结果超过页面读取上限，请缩小范围或减少每页数量。';
    if (error.kind === 'INVALID_INPUT') return error.message;
  }
  return '审计数据暂不可用，请稍后重试。';
}

/** A revoked read must hide any previously authorized list snapshot. */
export function auditAccessError(error: unknown): ApiError | null {
  return error instanceof ApiError && [401, 403].includes(error.status ?? 0)
    ? error
    : null;
}

export type AuditAccessState = { error: ApiError | null; listEpoch: number };
export type AuditAccessEvent =
  | { type: 'detail-revoked'; error: ApiError }
  | { type: 'list-succeeded'; listEpoch: number };

export function auditAccessReducer(
  state: AuditAccessState,
  event: AuditAccessEvent,
): AuditAccessState {
  if (event.type === 'detail-revoked') {
    return { error: event.error, listEpoch: state.listEpoch + 1 };
  }
  return event.listEpoch === state.listEpoch && state.error
    ? { ...state, error: null }
    : state;
}

export function auditVisibleList<T>(
  data: T | undefined,
  ...errors: unknown[]
): T | undefined {
  return errors.some((error) => auditAccessError(error)) ? undefined : data;
}
