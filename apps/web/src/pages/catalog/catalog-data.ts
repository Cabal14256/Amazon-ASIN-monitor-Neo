import { formatBeijing } from '../../lib/beijingTime';
import { ApiError } from '../../lib/http';
import type {
  CatalogAction,
  CatalogChild,
  CatalogGroup,
} from './catalog-types';

type Flag = 0 | 1 | boolean | null | undefined;

export function statusOf(value: Flag): 'danger' | 'success' | 'unknown' {
  if (value === 1 || value === true) return 'danger';
  if (value === 0 || value === false) return 'success';
  return 'unknown';
}

export function groupStatus(group: CatalogGroup) {
  return statusOf(group.isBroken ?? group.is_broken);
}

export function childStatus(child: CatalogChild) {
  return statusOf(child.isBroken ?? child.autoIsBroken);
}

export function asinManualAction(
  child: CatalogChild,
): 'MARK_BROKEN' | 'CLEAR_SELF_MANUAL' {
  if (child.selfManualBroken) return 'CLEAR_SELF_MANUAL';
  return 'MARK_BROKEN';
}

export function asinGroupManualAction(
  child: CatalogChild,
): 'EXCLUDE_GROUP_MANUAL' | 'CLEAR_GROUP_EXCLUSION' | undefined {
  if (child.manualBrokenScope === 'GROUP_EXCLUDED')
    return 'CLEAR_GROUP_EXCLUSION';
  if (child.inheritedManualBroken) return 'EXCLUDE_GROUP_MANUAL';
  return undefined;
}

export function asinManualScope(child: CatalogChild): string {
  switch (child.manualBrokenScope) {
    case 'GROUP':
      return '继承父变体标记';
    case 'GROUP_EXCLUDED':
      return '已排除父变体标记';
    case 'SELF+GROUP':
      return '自身与父变体均标记';
    case 'SELF':
      return '自身人工标记';
    default:
      return '无人工标记';
  }
}

export function statusSource(source?: string | null): string {
  switch (source) {
    case 'AUTO':
      return '自动检测';
    case 'MANUAL':
      return '人工标记';
    case 'AUTO+MANUAL':
      return '自动检测 + 人工标记';
    case 'NORMAL':
      return '正常';
    default:
      return source || '未记录';
  }
}

export function checkedAt(value?: string | null): string {
  if (!value) return '尚未检查';
  const formatted = formatBeijing(value, 'YYYY-MM-DD HH:mm');
  return formatted === 'Invalid Date' ? '时间未知' : formatted;
}

export function catalogError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 413)
      return '当前范围包含过多 ASIN，请缩小筛选范围后重试。';
    if (error.status === 503)
      return 'ASIN 数据源尚未开放，请稍后重试或使用现有入口。';
    if (error.kind === 'INVALID_RESPONSE' && error.message === '服务器响应过大')
      return '数据量超过页面可读取上限，请缩小筛选范围。';
    return error.message;
  }
  return '暂时无法读取 ASIN 数据，请稍后重试。';
}

export function catalogWriteError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.kind === 'INVALID_INPUT') return error.message;
    switch (error.status) {
      case 400:
        return '提交内容无效，请检查必填项、长度和站点信息。';
      case 401:
        return '登录状态已失效，正在重新验证。';
      case 403:
        return '当前账号没有执行此操作的权限，正在重新验证。';
      case 404:
        return '目标记录已不存在，请刷新目录。';
      case 409:
        if (error.message === '记录已变化')
          return '记录已被更新，请关闭表单并重新打开。';
        if (error.message === '该 ASIN 在此国家中已存在')
          return '该 ASIN 在所选国家中已存在，请检查编码。';
        if (error.message === 'ASIN 所属变体组已改变，请刷新后重试')
          return 'ASIN 已移动，请刷新目录后重试。';
        return 'ASIN 或变体组已存在，或目标状态已变化；请刷新后重试。';
      case 413:
        return '变体组包含过多 ASIN，本次操作未提交；请使用现有入口。';
      case 429:
        return '操作过于频繁，请稍后重试。';
      case 503:
        return 'ASIN 写入服务尚未开放，请使用现有入口。';
    }
    if (error.kind === 'INVALID_RESPONSE')
      return '服务器返回的结果不符合 ASIN 契约，请刷新后重试。';
  }
  return 'ASIN 操作暂不可用，请稍后重试。';
}

export function catalogAccessDenied(error: unknown): boolean {
  return error instanceof ApiError && [401, 403].includes(error.status ?? 0);
}

export function catalogActionAllowed(
  action: CatalogAction,
  canWrite: boolean,
  canDelete: boolean,
): boolean {
  return action.type === 'delete-group' || action.type === 'delete-asin'
    ? canDelete
    : canWrite;
}

export function catalogActionSourceCurrent(
  action: CatalogAction,
  latest: CatalogGroup,
): boolean {
  if (action.type === 'group-notify')
    return (
      action.group.id === latest.id &&
      action.group.feishuNotifyEnabled === latest.feishuNotifyEnabled
    );
  if (action.type === 'group-manual')
    return (
      action.group.id === latest.id &&
      action.group.manualBroken === latest.manualBroken &&
      action.group.manualBrokenReason === latest.manualBrokenReason &&
      action.group.statusSource === latest.statusSource
    );
  if (
    action.type === 'edit-group' ||
    action.type === 'delete-group' ||
    action.type === 'create-asin'
  )
    return (
      action.group.id === latest.id &&
      action.group.name === latest.name &&
      action.group.country === latest.country &&
      action.group.site === latest.site &&
      action.group.brand === latest.brand
    );
  if ('child' in action) {
    const current = latest.children?.find(
      (item) => item.id === action.child.id,
    );
    if (!current || latest.id !== action.group.id) return false;
    if (action.type === 'asin-notify')
      return action.child.feishuNotifyEnabled === current.feishuNotifyEnabled;
    if (action.type === 'asin-manual')
      return (
        action.child.manualBrokenScope === current.manualBrokenScope &&
        action.child.selfManualBroken === current.selfManualBroken &&
        action.child.inheritedManualBroken === current.inheritedManualBroken &&
        action.child.manualExcludedFromGroup ===
          current.manualExcludedFromGroup &&
        action.child.manualBrokenReason === current.manualBrokenReason &&
        action.child.manualExcludedReason === current.manualExcludedReason
      );
    if (action.type !== 'edit-asin') return true;
    return Boolean(
      action.child.asin === current.asin &&
        (action.child.name ?? '') === (current.name ?? '') &&
        action.child.country === current.country &&
        (action.child.site ?? '') === (current.site ?? '') &&
        (action.child.brand ?? '') === (current.brand ?? '') &&
        String(action.child.asinType ?? '') === String(current.asinType ?? ''),
    );
  }
  return true;
}

export function singleAsinCode(value: string): string | null {
  const code = value.trim().toUpperCase();
  return /^[A-Z0-9]{10}$/.test(code) ? code : null;
}
