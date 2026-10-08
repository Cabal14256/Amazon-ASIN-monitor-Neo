import type { AsinExportParams, VariantGroup } from '@asin-monitor/contracts';
import { parseShanghaiTimestamp } from '@asin-monitor/db';

export const ASIN_EXPORT_DETAILED_HEADER = [
  '变体组名称',
  '变体组ID',
  '国家',
  '站点',
  '品牌',
  '变体状态',
  '变体状态来源',
  'ASIN',
  'ASIN名称',
  'ASIN类型',
  'ASIN状态',
  'ASIN状态来源',
  '人工异常原因',
  '创建时间',
  '最后检查时间',
] as const;
export const ASIN_EXPORT_DETAILED_WIDTHS = [
  20, 40, 10, 10, 15, 10, 12, 15, 50, 15, 10, 12, 30, 20, 20,
];

const TASK_COLUMN_INDICES = [0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 13, 14];
export const ASIN_EXPORT_HEADER = TASK_COLUMN_INDICES.map(
  (index) => ASIN_EXPORT_DETAILED_HEADER[index]!,
);
export const ASIN_EXPORT_WIDTHS = TASK_COLUMN_INDICES.map(
  (index) => ASIN_EXPORT_DETAILED_WIDTHS[index]!,
);
export function asinExportFormat(layout?: AsinExportParams['layout']) {
  return layout === 'detailed'
    ? {
        header: ASIN_EXPORT_DETAILED_HEADER,
        widths: ASIN_EXPORT_DETAILED_WIDTHS,
      }
    : { header: ASIN_EXPORT_HEADER, widths: ASIN_EXPORT_WIDTHS };
}
export type AsinExportCell = string | Date;

function excelInstant(value: string | null | undefined): Date | '' {
  if (!value) return '';
  const date = parseShanghaiTimestamp(value);
  if (!Number.isFinite(date.getTime()))
    throw new RangeError('Invalid ASIN export timestamp');
  return date;
}
const status = (broken: number | boolean | null | undefined) =>
  broken === 1 || broken === true ? '异常' : '正常';

/** Preserve each Legacy layout and the Date instants emitted by mysql2. */
export function* asinExportRows(
  groups: readonly VariantGroup[],
  layout: AsinExportParams['layout'] = 'task',
): Generator<AsinExportCell[]> {
  const select = (row: AsinExportCell[]) =>
    layout === 'detailed'
      ? row
      : TASK_COLUMN_INDICES.map((index) => row[index]!);
  for (const group of groups) {
    const prefix: string[] = [
      group.name || '',
      group.id || '',
      group.country || '',
      group.site || '',
      group.brand || '',
      status(group.isBroken),
      group.statusSource || '',
    ];
    if (group.children?.length) {
      for (const asin of group.children)
        yield select([
          ...prefix,
          asin.asin || '',
          asin.name || '',
          asin.asinType == null ? '' : String(asin.asinType),
          status(asin.isBroken),
          asin.statusSource || '',
          asin.manualBrokenReason || group.manualBrokenReason || '',
          excelInstant(asin.createTime),
          excelInstant(asin.lastCheckTime),
        ]);
    } else {
      yield select([
        ...prefix,
        '',
        '',
        '',
        '',
        '',
        group.manualBrokenReason || '',
        excelInstant(group.createTime),
        '',
      ]);
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
