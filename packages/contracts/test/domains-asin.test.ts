import { describe, expect, it } from 'vitest';

import {
  asinManualBrokenRequestSchema,
  batchCreateAsinsResultSchema,
  batchDeleteVariantGroupsRequestSchema,
  batchDeleteVariantGroupsResultSchema,
  createAsinRequestSchema,
  deleteAsinResultSchema,
  deleteVariantGroupResultSchema,
  feishuNotifyRequestSchema,
  groupManualBrokenRequestSchema,
  importExcelResultSchema,
  variantGroupListResultSchema,
} from '../src/domains/asin';
import {
  asinCheckResultSchema,
  batchCheckResultSchema,
  batchQueryParentAsinRequestSchema,
  batchQueryParentAsinResultSchema,
  variantGroupCheckResultSchema,
} from '../src/domains/variantCheck';

/**
 * asin / variant-check 域契约测试。
 */

describe('asin 域', () => {
  it('变体组列表 data 含 totalASINs 与 children 装饰字段', () => {
    const parsed = variantGroupListResultSchema.parse({
      success: true,
      errorCode: 0,
      data: {
        list: [
          {
            id: 'g1',
            name: '组A',
            country: 'US',
            site: 'amazon.com',
            brand: 'B',
            asin_count: 1,
            isBroken: 1,
            variantStatus: 'BROKEN',
            feishuNotifyEnabled: 1,
            children: [
              {
                id: 'a1',
                asin: 'B0ABC12345',
                asinType: '1',
                country: 'US',
                parentId: 'g1',
                isBroken: 0,
                manualBroken: 1,
                statusSource: 'MANUAL',
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
    expect(parsed.data?.list[0].children?.[0].asin).toBe('B0ABC12345');
    expect(parsed.data?.list[0].isBroken).toBe(1);
    expect(parsed.data?.list[0].children?.[0].isBroken).toBe(0);
  });

  it('创建 ASIN 拒绝非法 asinType', () => {
    expect(() =>
      createAsinRequestSchema.parse({
        asin: 'B0ABC12345',
        country: 'US',
        site: 'amazon.com',
        brand: 'B',
        parentId: 'g1',
        asinType: '3',
      }),
    ).toThrow();
  });

  it('人工异常请求同时支持 action 与 markedBroken 兼容形态', () => {
    expect(
      asinManualBrokenRequestSchema.parse({
        action: ' mark_broken ',
        reason: '断货',
      }).action,
    ).toBe('MARK_BROKEN');
    expect(
      asinManualBrokenRequestSchema.parse({ markedBroken: '0' }).markedBroken,
    ).toBe('0');
    expect(() => asinManualBrokenRequestSchema.parse({})).toThrow();
    expect(() =>
      asinManualBrokenRequestSchema.parse({ markedBroken: 1 }),
    ).toThrow();
    expect(() =>
      asinManualBrokenRequestSchema.parse({ action: 'EXCLUDE_GROUP_MANUAL' }),
    ).toThrow();
  });

  it('通知开关与组人工异常匹配控制器 0/1 语义', () => {
    expect(feishuNotifyRequestSchema.parse({ enabled: 0 }).enabled).toBe(0);
    expect(() => feishuNotifyRequestSchema.parse({ enabled: '0' })).toThrow();
    expect(
      groupManualBrokenRequestSchema.parse({ markedBroken: '0' }).markedBroken,
    ).toBe('0');
    expect(() =>
      groupManualBrokenRequestSchema.parse({ markedBroken: true }),
    ).toThrow();
  });

  it('批量删除至少需要一个非空目标', () => {
    expect(() => batchDeleteVariantGroupsRequestSchema.parse({})).toThrow();
    expect(() =>
      batchDeleteVariantGroupsRequestSchema.parse({
        groupIds: [],
        asinIds: [' '],
      }),
    ).toThrow();
    expect(
      batchDeleteVariantGroupsRequestSchema.parse({ groupIds: ['g1'] })
        .groupIds,
    ).toEqual(['g1']);
  });

  it('批量删除同步/异步两种 data 均可解析', () => {
    const sync = batchDeleteVariantGroupsResultSchema.parse({
      success: true,
      data: {
        mode: 'sync',
        totalRequested: 3,
        deletedGroupCount: 1,
        deletedDirectAsinCount: 2,
        deletedNestedAsinCount: 5,
        skipped: { groupIds: [], asinIds: ['a9'] },
      },
    });
    expect(sync.data?.mode).toBe('sync');

    const asyncRes = batchDeleteVariantGroupsResultSchema.parse({
      success: true,
      data: {
        mode: 'async',
        taskId: 't1',
        status: 'pending',
        totalRequested: 3,
        estimatedAsinCount: 7,
      },
    });
    expect(asyncRes.data?.mode).toBe('async');
  });

  it('变体组与 ASIN 单项删除返回字符串 data', () => {
    expect(
      deleteVariantGroupResultSchema.parse({
        success: true,
        data: '删除成功',
      }).data,
    ).toBe('删除成功');
    expect(
      deleteAsinResultSchema.parse({ success: true, data: '删除成功' }).data,
    ).toBe('删除成功');
  });

  it('批量创建结果含 results/errors 明细', () => {
    const parsed = batchCreateAsinsResultSchema.parse({
      success: true,
      data: {
        total: 2,
        successCount: 1,
        failedCount: 1,
        results: [
          { index: 0, asin: 'B0ABC12345', success: true },
          { index: 1, asin: 'BAD', success: false, message: '格式错误' },
        ],
        errors: [{ index: 1, asin: 'BAD', message: '格式错误' }],
      },
    });
    expect(parsed.data?.failedCount).toBe(1);
  });

  it('Excel 导入同步与异步受理均可解析', () => {
    expect(
      importExcelResultSchema.parse({
        success: true,
        data: {
          total: 10,
          processedCount: 10,
          successCount: 9,
          failedCount: 1,
          missingCount: 0,
          verificationPassed: true,
        },
      }).data,
    ).toMatchObject({ verificationPassed: true });
    expect(
      importExcelResultSchema.parse({
        success: true,
        errorCode: 0,
        data: { taskId: 't2', status: 'pending' },
      }).data,
    ).toMatchObject({ taskId: 't2' });
    expect(
      importExcelResultSchema.parse({
        success: false,
        errorCode: 500,
        errorMessage: '解析失败',
        data: {
          successCount: 0,
          failedCount: 0,
          errors: [{ message: '解析失败' }],
        },
      }).data,
    ).toMatchObject({ successCount: 0, failedCount: 0 });
  });
});

describe('variant-check 域', () => {
  it('父变体查询 ASIN 会归一化并拒绝非法成员', () => {
    expect(
      batchQueryParentAsinRequestSchema.parse({
        asins: [' b0abc12345 '],
        country: 'US',
        useAsync: false,
      }).asins,
    ).toEqual(['B0ABC12345']);
    expect(() =>
      batchQueryParentAsinRequestSchema.parse({
        asins: ['bad'],
        country: 'US',
        useAsync: false,
      }),
    ).toThrow();
  });

  it('组检查同步结果 details.results 项带 variantView', () => {
    const parsed = variantGroupCheckResultSchema.parse({
      success: true,
      errorCode: 0,
      data: {
        isBroken: true,
        details: {
          results: [
            {
              asin: 'B0ABC12345',
              variantView: {
                asin: 'B0ABC12345',
                title: 'T',
                hasVariation: false,
                isBroken: true,
                parentAsin: null,
                brotherAsins: [],
                brand: null,
                raw: null,
              },
            },
          ],
        },
      },
    });
    expect(parsed.data).toMatchObject({ isBroken: true });
  });

  it('单 ASIN 检查同步结果为 variantView', () => {
    const parsed = asinCheckResultSchema.parse({
      success: true,
      data: {
        asin: 'B0ABC12345',
        title: '',
        hasVariation: true,
        isBroken: false,
        parentAsin: 'B0PARENT01',
        brotherAsins: ['B0BRO00001'],
        brand: 'B',
        raw: {},
      },
    });
    expect(parsed.data).toMatchObject({ hasVariation: true });
  });

  it('异步受理形态可用于检查端点', () => {
    const parsed = asinCheckResultSchema.parse({
      success: true,
      data: { taskId: 't3', status: 'pending', taskType: 'asin-check' },
    });
    expect(parsed.data).toMatchObject({ taskId: 't3' });
  });

  it('批量检查同步结果逐项含 groupId/success', () => {
    const parsed = batchCheckResultSchema.parse({
      success: true,
      data: {
        total: 2,
        results: [
          { groupId: 'g1', success: true, isBroken: false },
          { groupId: 'g2', success: false, error: '超时' },
        ],
      },
    });
    expect(parsed.data).toMatchObject({ total: 2 });
  });

  it('父变体查询结果数组形态', () => {
    const parsed = batchQueryParentAsinResultSchema.parse({
      success: true,
      errorCode: 0,
      data: [
        {
          asin: 'B0ABC12345',
          hasParentAsin: true,
          parentAsin: 'B0PARENT01',
          parentTitle: '父体标题',
          title: 'T',
          brand: 'B',
          hasVariants: true,
          variantCount: 3,
          error: null,
        },
      ],
    });
    expect(Array.isArray(parsed.data)).toBe(true);
  });
});
