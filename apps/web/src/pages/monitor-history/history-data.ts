import type {
  MonitorHistoryListData,
  MonitorHistoryRecord,
} from '@asin-monitor/contracts';
import { formatBeijing } from '../../lib/beijingTime';
import { ApiError } from '../../lib/http';

type Flag = 0 | 1 | boolean | null | undefined;

export function historyFlag(value: Flag): {
  label: string;
  badge: 'danger' | 'success' | 'unknown';
} {
  if (value === 1 || value === true) return { label: '异常', badge: 'danger' };
  if (value === 0 || value === false)
    return { label: '正常', badge: 'success' };
  return { label: '状态未记录', badge: 'unknown' };
}

export function historyStatus(record: MonitorHistoryRecord) {
  return historyFlag(record.isBroken ?? record.is_broken);
}

export function historyNotification(record: MonitorHistoryRecord): string {
  const value = record.notificationSent ?? record.notification_sent;
  if (value === 1 || value === true) return '已通知';
  if (value === 0 || value === false) return '未通知';
  return '通知状态未记录';
}

export function historyTime(value: string | null | undefined): string {
  if (!value) return '未记录';
  const formatted = formatBeijing(value, 'YYYY-MM-DD HH:mm:ss');
  return formatted === 'Invalid Date' ? '时间未知' : formatted;
}

export function historyResultPreview(record: MonitorHistoryRecord): {
  text: string;
  truncated: boolean;
} {
  const raw = record.checkResult ?? record.check_result;
  if (!raw) return { text: '未记录检查结果', truncated: false };
  const limit = 4000;
  return { text: raw.slice(0, limit), truncated: raw.length > limit };
}

/** null total is a deliberate API fast path, never a zero count. */
export function historyPageInfo(data: MonitorHistoryListData): {
  count: string;
  canNext: boolean;
} {
  const count = data.total === null ? '总量未统计' : `共 ${data.total} 条`;
  const nextOffset = data.current * data.pageSize;
  const canNext =
    nextOffset <= 1_000_000 &&
    (data.total === null
      ? data.list.length === data.pageSize
      : nextOffset < data.total);
  return { count, canNext };
}

export function historyError(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.status) {
      case 400:
        return '筛选参数无效，请检查时间范围和分页设置。';
      case 403:
        return '当前账号没有监控历史读取权限，请联系管理员。';
      case 404:
        return '这条历史记录已不存在，请刷新列表。';
      case 413:
        return '结果过大，请缩小时间或 ASIN 范围，或减少每页数量。';
      case 429:
        return '查询繁忙，请稍后重试。';
      case 503:
        return '监控历史数据源暂不可用，请稍后重试。';
    }
    if (error.kind === 'INVALID_RESPONSE' && error.message === '服务器响应过大')
      return '页面读取上限已达到，请缩小范围或减少每页数量。';
    return error.message;
  }
  return '监控历史暂不可用，请稍后重试。';
}

/** datetime-local is a wall clock: send it as Shanghai time, without UTC conversion. */
export function historyWallTime(value: string): string | undefined {
  if (!value) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value))
    return undefined;
  if (Number(value.slice(0, 4)) < 1000) return undefined;
  const full = value.length === 16 ? `${value}:00` : value;
  const date = new Date(`${full}Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 19) !== full
  )
    return undefined;
  return full.replace('T', ' ');
}
