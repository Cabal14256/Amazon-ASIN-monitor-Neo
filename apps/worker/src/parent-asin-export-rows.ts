import type { ParentAsinQueryItem } from '@asin-monitor/contracts';
import { formatShanghaiTimestamp } from '@asin-monitor/db';

export const PARENT_ASIN_EXPORT_HEADER = [
  'ASIN',
  '国家',
  '是否有父变体',
  '父变体ASIN',
  '父体标题',
  '产品标题',
  '品牌',
  '是否有变体',
  '变体数量',
  '查询时间',
  '错误信息',
] as const;
export const PARENT_ASIN_EXPORT_WIDTHS = [
  15, 10, 15, 15, 50, 50, 20, 15, 12, 20, 30,
];
export const parentAsinExportFilename = (at: Date) =>
  `ASIN父变体查询结果_${formatShanghaiTimestamp(at).slice(0, 10)}.xlsx`;
export function* parentAsinExportRows(
  results: readonly ParentAsinQueryItem[],
  country: string,
  at: Date,
): Generator<(string | number)[]> {
  const queryTime = formatShanghaiTimestamp(at).slice(0, 19);
  for (const result of results)
    yield [
      result.asin || '',
      country || '',
      result.hasParentAsin ? '是' : '否',
      result.parentAsin || '',
      result.parentTitle || '',
      result.title || '',
      result.brand || '',
      result.hasVariants ? '是' : '否',
      result.variantCount || 0,
      queryTime,
      result.error || '',
    ];
}
