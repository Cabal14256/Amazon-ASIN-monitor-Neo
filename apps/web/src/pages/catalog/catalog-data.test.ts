import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/http';
import {
  catalogAccessDenied,
  catalogActionAllowed,
  catalogActionSourceCurrent,
  catalogError,
  catalogWriteError,
  checkedAt,
  childStatus,
  groupStatus,
  singleAsinCode,
  statusSource,
} from './catalog-data';

describe('shared ASIN catalog display data', () => {
  it('uses effective status before the stored automatic flag', () => {
    expect(
      groupStatus({
        id: 'g',
        name: 'group',
        country: 'US',
        brand: 'brand',
        isBroken: 0,
        is_broken: 1,
      }),
    ).toBe('success');
    expect(
      childStatus({
        id: 'c',
        asin: 'B00TEST',
        country: 'US',
        isBroken: 1,
        autoIsBroken: 0,
      }),
    ).toBe('danger');
    expect(
      childStatus({ id: 'c', asin: 'B00TEST', country: 'US', isBroken: null }),
    ).toBe('unknown');
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
  it('limits single-item actions to their current write or delete permission', () => {
    const group = {
      id: 'group-1',
      name: 'Group',
      country: 'US',
      brand: 'Brand',
    };
    expect(catalogActionAllowed({ type: 'create-group' }, true, false)).toBe(
      true,
    );
    expect(
      catalogActionAllowed({ type: 'edit-group', group }, false, true),
    ).toBe(false);
    expect(
      catalogActionAllowed({ type: 'delete-group', group }, false, true),
    ).toBe(true);
    expect(
      catalogActionAllowed({ type: 'delete-group', group }, true, false),
    ).toBe(false);
  });
  it('hides raw write failures and identifies session or permission loss', () => {
    const denied = new ApiError('HTTP', 'private backend payload', 403);
    expect(catalogAccessDenied(denied)).toBe(true);
    expect(catalogAccessDenied(new ApiError('HTTP', 'conflict', 409))).toBe(
      false,
    );
    expect(catalogWriteError(denied)).not.toContain('private backend payload');
    expect(
      catalogWriteError(new ApiError('HTTP', 'private backend payload', 400)),
    ).not.toContain('private backend payload');
    expect(catalogWriteError(new ApiError('HTTP', 'duplicate', 409))).toContain(
      '已存在',
    );
    expect(
      catalogWriteError(new ApiError('HTTP', '该 ASIN 在此国家中已存在', 409)),
    ).toContain('所选国家');
    expect(
      catalogWriteError(new ApiError('HTTP', 'raw sensitive details', 413)),
    ).not.toContain('raw sensitive');
  });
  it('rejects an edit when another operator changed the source record', () => {
    const group = {
      id: 'group-1',
      name: 'Group',
      country: 'US',
      site: 'amazon.com',
      brand: 'Brand',
      children: [
        {
          id: 'child-1',
          asin: 'B00TEST',
          name: 'Original',
          country: 'US',
          site: 'amazon.com',
          brand: 'Brand',
          asinType: '1',
        },
      ],
    };
    expect(
      catalogActionSourceCurrent({ type: 'edit-group', group }, group),
    ).toBe(true);
    expect(
      catalogActionSourceCurrent(
        { type: 'edit-group', group },
        { ...group, brand: 'New brand' },
      ),
    ).toBe(false);
    expect(
      catalogActionSourceCurrent(
        { type: 'edit-asin', group, child: group.children[0] },
        group,
      ),
    ).toBe(true);
    expect(
      catalogActionSourceCurrent(
        { type: 'edit-asin', group, child: group.children[0] },
        { ...group, children: [] },
      ),
    ).toBe(false);
    expect(
      catalogActionSourceCurrent(
        { type: 'move-asin', group, child: group.children[0] },
        { ...group, children: [] },
      ),
    ).toBe(false);
    expect(
      catalogActionSourceCurrent(
        { type: 'delete-asin', group, child: group.children[0] },
        group,
      ),
    ).toBe(true);
    expect(
      catalogActionSourceCurrent(
        { type: 'edit-asin', group, child: group.children[0] },
        { ...group, children: [{ ...group.children[0], name: 'Other edit' }] },
      ),
    ).toBe(false);
  });
  it('normalizes one ASIN code and rejects multi-code or malformed input', () => {
    expect(singleAsinCode(' b0chx1w1xy ')).toBe('B0CHX1W1XY');
    expect(singleAsinCode('B0CHX1W1XY, B00TEST123')).toBeNull();
    expect(singleAsinCode('B00SHORT')).toBeNull();
  });
});
