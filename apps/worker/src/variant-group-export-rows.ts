import { parseShanghaiTimestamp } from '@asin-monitor/db';

export const VARIANT_GROUP_EXPORT_SHEET = '变体组数据';
export const VARIANT_GROUP_EXPORT_HEADER = [
  '变体组名称',
  '变体组ID',
  '国家',
  '站点',
  '品牌',
  '变体状态',
  'ASIN数量',
  '异常ASIN数量',
  '创建时间',
  '更新时间',
  '最后检查时间',
] as const;
export const VARIANT_GROUP_EXPORT_WIDTHS = [
  30, 40, 10, 10, 15, 10, 10, 12, 20, 20, 20,
] as const;

export interface VariantGroupExportFields {
  name: string | null;
  id: string | null;
  country: string | null;
  site: string | null;
  brand: string | null;
  isBroken: number | boolean | null;
  asinCount: number;
  brokenAsinCount: number;
  createTime?: string | Date | null;
  updateTime?: string | Date | null;
  lastCheckTime?: string | Date | null;
}

export type VariantGroupExportCell = string | number | Date;

function excelInstant(value: string | Date | null | undefined): Date | '' {
  if (value == null || value === '') return '';
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime()))
      throw new RangeError('Invalid variant group export timestamp');
    return value;
  }
  const date = parseShanghaiTimestamp(value);
  if (!Number.isFinite(date.getTime()))
    throw new RangeError('Invalid variant group export timestamp');
  return date;
}

function status(broken: number | boolean | null): string {
  return broken === 1 || broken === true ? '异常' : '正常';
}

export function variantGroupExportRow(
  group: VariantGroupExportFields,
): VariantGroupExportCell[] {
  return [
    group.name ?? '',
    group.id ?? '',
    group.country ?? '',
    group.site ?? '',
    group.brand ?? '',
    status(group.isBroken),
    group.asinCount,
    group.brokenAsinCount,
    excelInstant(group.createTime),
    excelInstant(group.updateTime),
    excelInstant(group.lastCheckTime),
  ];
}
