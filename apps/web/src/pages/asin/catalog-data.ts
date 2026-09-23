import type { DecoratedAsin, VariantGroup } from '@asin-monitor/contracts';
import { formatBeijing } from '../../lib/beijingTime';
import { ApiError } from '../../lib/http';

type Flag = 0 | 1 | boolean | null | undefined;

export function statusOf(value: Flag): 'danger' | 'success' | 'unknown' {
  if (value === 1 || value === true) return 'danger';
  if (value === 0 || value === false) return 'success';
  return 'unknown';
}

export function groupStatus(group: VariantGroup) {
  return statusOf(group.isBroken ?? group.is_broken);
}

export function childStatus(child: DecoratedAsin) {
  return statusOf(child.isBroken ?? child.autoIsBroken);
}

export function statusSource(source?: string | null): string {
  switch (source) {
    case 'AUTO':
      return '自动检测';
    case 'MANUAL':
      return '人工标记';
    case 'AUTO+MANUAL':
      return '自动检测 + 人工标记';
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
