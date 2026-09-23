import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/http';
import {
  catalogError,
  checkedAt,
  childStatus,
  groupStatus,
  statusSource,
} from './catalog-data';

describe('ASIN catalog display data', () => {
  it('uses effective status before the stored automatic flag', () => {
    expect(groupStatus({ isBroken: 0, is_broken: 1 } as never)).toBe('success');
    expect(childStatus({ isBroken: 1, autoIsBroken: 0 } as never)).toBe(
      'danger',
    );
    expect(statusSource('AUTO+MANUAL')).toBe('自动检测 + 人工标记');
    expect(statusSource('NORMAL')).toBe('正常');
  });
  it('renders missing and invalid timestamps without implying a check occurred', () => {
    expect(checkedAt(null)).toBe('尚未检查');
    expect(checkedAt('invalid')).toBe('时间未知');
    expect(checkedAt('2026-01-01T00:00:00Z')).toBe('2026-01-01 08:00');
  });
  it('turns capacity and authority errors into actionable page messages', () => {
    expect(catalogError(new ApiError('HTTP', 'raw', 413))).toContain(
      '缩小筛选范围',
    );
    expect(catalogError(new ApiError('HTTP', 'raw', 503))).toContain(
      '数据源尚未开放',
    );
    expect(
      catalogError(new ApiError('INVALID_RESPONSE', '服务器响应过大')),
    ).toContain('缩小筛选范围');
  });
});
