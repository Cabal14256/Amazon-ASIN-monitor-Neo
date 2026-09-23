import type { MonitorHistoryRecord } from '@asin-monitor/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/http';
import {
  historyError,
  historyNotification,
  historyPageInfo,
  historyResultPreview,
  historyStatus,
  historyTime,
  historyWallTime,
} from './history-data';

const record = (
  patch: Partial<MonitorHistoryRecord> = {},
): MonitorHistoryRecord => ({
  id: 5,
  check_time: '2026-09-22T16:00:00Z',
  is_broken: null,
  notification_sent: null,
  check_result: null,
  ...patch,
});

describe('monitor history display boundaries', () => {
  it('preserves unknown flags, Shanghai time and bounded detail text', () => {
    expect(historyStatus(record()).label).toBe('状态未记录');
    expect(historyStatus(record({ is_broken: 1 })).label).toBe('异常');
    expect(historyStatus(record({ is_broken: false })).label).toBe('正常');
    expect(historyNotification(record())).toBe('通知状态未记录');
    expect(historyNotification(record({ notification_sent: 1 }))).toBe(
      '已通知',
    );
    expect(historyTime('2026-09-22T16:00:00Z')).toBe('2026-09-23 00:00:00');
    const preview = historyResultPreview(
      record({ check_result: 'x'.repeat(10_000) }),
    );
    expect(preview.text).toHaveLength(4000);
    expect(preview.truncated).toBe(true);
  });

  it('never presents an uncounted total as zero and bounds next-page navigation', () => {
    const list = [record(), record({ id: 6 })];
    expect(
      historyPageInfo({ list, total: null, current: 1, pageSize: 2 }),
    ).toEqual({
      count: '总量未统计',
      canNext: true,
    });
    expect(
      historyPageInfo({ list: [], total: 0, current: 1, pageSize: 2 }),
    ).toEqual({
      count: '共 0 条',
      canNext: false,
    });
    expect(
      historyPageInfo({
        list: [record()],
        total: null,
        current: 2,
        pageSize: 2,
      }).canNext,
    ).toBe(false);
    expect(
      historyPageInfo({ list, total: null, current: 500_001, pageSize: 2 })
        .canNext,
    ).toBe(false);
  });

  it('sends datetime-local values as valid Shanghai wall clocks without UTC conversion', () => {
    expect(historyWallTime('2026-09-23T09:45')).toBe('2026-09-23 09:45:00');
    expect(historyWallTime('2026-09-23T09:45:30')).toBe('2026-09-23 09:45:30');
    expect(historyWallTime('2026-02-30T09:45')).toBeUndefined();
    expect(historyWallTime('0000-01-01T00:00')).toBeUndefined();
  });

  it.each([
    [400, '筛选参数'],
    [403, '没有监控历史读取权限'],
    [404, '不存在'],
    [413, '结果过大'],
    [429, '查询繁忙'],
    [503, '数据源暂不可用'],
  ])('gives an actionable message for API %s', (status, message) => {
    expect(historyError(new ApiError('HTTP', 'failed', status))).toContain(
      message,
    );
  });
});
