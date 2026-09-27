import type { VariantGroup } from '@asin-monitor/contracts';
import { formatShanghaiTimestamp } from '@asin-monitor/db';

export const ASIN_EXPORT_HEADER = [
  '变体组名称',
  '变体组ID',
  '国家',
  '站点',
  '品牌',
  '变体状态',
  'ASIN',
  'ASIN名称',
  'ASIN类型',
  'ASIN状态',
  '创建时间',
  '最后检查时间',
] as const;
export const ASIN_EXPORT_WIDTHS = [
  20, 40, 10, 10, 15, 10, 15, 50, 15, 10, 20, 20,
];

function shanghai(value: string | null | undefined): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? formatShanghaiTimestamp(date).slice(0, 19)
    : '';
}
const status = (broken: number | boolean | null | undefined) =>
  broken === 1 || broken === true ? '异常' : '正常';

/** Legacy ASIN export's twelve columns, with D8 Shanghai wall-clock dates. */
export function* asinExportRows(
  groups: readonly VariantGroup[],
): Generator<string[]> {
  for (const group of groups) {
    const prefix: string[] = [
      group.name || '',
      group.id || '',
      group.country || '',
      group.site || '',
      group.brand || '',
      status(group.isBroken),
    ];
    if (group.children?.length) {
      for (const asin of group.children)
        yield [
          ...prefix,
          asin.asin || '',
          asin.name || '',
          asin.asinType == null ? '' : String(asin.asinType),
          status(asin.isBroken),
          shanghai(asin.createTime),
          shanghai(asin.lastCheckTime),
        ];
    } else {
      yield [...prefix, '', '', '', '', shanghai(group.createTime), ''];
    }
  }
}

export function asinExportFilename(at: Date): string {
  const date = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
  return `ASIN数据_${date}.xlsx`;
}
