import { describe, expect, it } from 'vitest';

import {
  competitorBatchCheckResultSchema,
  competitorCheckResultSchema,
  competitorDeleteAsinResultSchema,
  competitorDeleteGroupResultSchema,
  competitorGroupListResultSchema,
  competitorGroupUpsertRequestSchema,
  competitorMonitorHistoryListResultSchema,
  competitorMonitorTriggerResultSchema,
} from '../src/domains/competitor';

/**
 * competitor 三域契约测试。
 */

describe('competitor 域', () => {
  it('竞对变体组列表：无 site，children 无人工异常装饰', () => {
    const parsed = competitorGroupListResultSchema.parse({
      success: true,
      data: {
        list: [
          {
            id: 'cg1',
            name: '竞对组',
            country: 'US',
            brand: 'C',
            asin_count: 1,
            children: [
              {
                id: 'ca1',
                asin: 'B0COMP0001',
                country: 'US',
                brand: 'C',
                parentId: 'cg1',
                isBroken: 0,
                feishuNotifyEnabled: 0,
              },
            ],
          },
        ],
        total: 1,
        totalASINs: 1,
        current: 1,
        pageSize: 10,
      },
    });
    expect(parsed.data?.list[0].children?.[0].feishuNotifyEnabled).toBe(0);
  });

  it('竞对组创建请求不接受 site', () => {
    const parsed = competitorGroupUpsertRequestSchema.parse({
      name: 'n',
      country: 'US',
      brand: 'b',
    });
    expect('site' in parsed).toBe(false);
  });

  it('竞对监控历史列表与主营同构', () => {
    const parsed = competitorMonitorHistoryListResultSchema.parse({
      success: true,
      data: {
        list: [
          {
            id: 9,
            asin: 'B0COMP0001',
            parentAsin: 'B0PARENT01',
            is_broken: 1,
            checkTime: '2026-08-24 11:00:00',
          },
        ],
        total: 1,
        current: 1,
        pageSize: 10,
      },
    });
    expect(parsed.data?.list[0].asin).toBe('B0COMP0001');
    expect(parsed.data?.list[0].parentAsin).toBe('B0PARENT01');
  });

  it('竞对监控触发结果包含 runner 汇总与逐国明细', () => {
    const parsed = competitorMonitorTriggerResultSchema.parse({
      success: true,
      errorCode: 0,
      data: {
        success: true,
        totalChecked: 2,
        totalBroken: 1,
        totalNormal: 1,
        countryResults: {
          US: {
            country: 'US',
            totalGroups: 2,
            brokenGroups: 1,
            brokenGroupNames: ['竞对组'],
            brokenGroupDetails: [
              { variantGroupId: 'cg1', groupName: '竞对组' },
            ],
            brokenASINs: [{ asin: 'B0COMP0001' }],
            brokenByType: {
              SP_API_ERROR: 0,
              NOT_FOUND: 1,
              NO_VARIANTS: 0,
            },
            asinClassifications: { 'asin:ca1': 'NOT_FOUND' },
            checkedGroupKeys: ['group:cg1', 'asin:ca1'],
            checkTime: '2026-08-25T10:00:00.000Z',
          },
        },
        notifyResults: {
          total: 1,
          success: 1,
          failed: 0,
          skipped: 0,
          countryResults: { US: { success: true, skipped: false } },
        },
        duration: 1.25,
        checkTime: '2026-08-25T10:00:00.000Z',
      },
    });
    expect(parsed.data).toMatchObject({
      totalChecked: 2,
      totalBroken: 1,
      totalNormal: 1,
    });
    expect(parsed.data?.countryResults.US.brokenGroups).toBe(1);
  });

  it('竞对监控触发早退失败允许省略未计算的汇总字段', () => {
    const parsed = competitorMonitorTriggerResultSchema.parse({
      success: false,
      errorCode: 500,
      errorMessage: '竞品监控已关闭',
      data: {
        success: false,
        error: '竞品监控已关闭',
        totalChecked: 0,
        totalBroken: 0,
        countryResults: {},
      },
    });
    expect(parsed.data).toMatchObject({
      success: false,
      totalChecked: 0,
      totalBroken: 0,
    });
  });

  it('竞对组与 ASIN 单项删除返回字符串 data', () => {
    expect(
      competitorDeleteGroupResultSchema.parse({
        success: true,
        data: '删除成功',
      }).data,
    ).toBe('删除成功');
    expect(
      competitorDeleteAsinResultSchema.parse({
        success: true,
        data: '删除成功',
      }).data,
    ).toBe('删除成功');
  });

  it('竞对组检查同步结果含 isBroken/details', () => {
    const parsed = competitorCheckResultSchema.parse({
      success: true,
      errorCode: 0,
      data: { isBroken: false, brokenASINs: [], details: { results: [] } },
    });
    expect(parsed.data).toMatchObject({ isBroken: false });
  });

  it('竞对批量检查支持异步受理形态', () => {
    const parsed = competitorBatchCheckResultSchema.parse({
      success: true,
      data: { taskId: 'ct1', status: 'pending', total: 5 },
    });
    expect(parsed.data).toMatchObject({ taskId: 'ct1' });
  });
});
