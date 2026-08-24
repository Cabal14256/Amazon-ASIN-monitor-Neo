import { describe, expect, it } from 'vitest';

import {
  competitorBatchCheckResultSchema,
  competitorCheckResultSchema,
  competitorGroupListResultSchema,
  competitorGroupUpsertRequestSchema,
  competitorMonitorHistoryListResultSchema,
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
