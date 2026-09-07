import type { BatchCreateAsinsData } from '@asin-monitor/contracts';
import { randomUUID } from 'node:crypto';

export const MAX_ASIN_BATCH_CREATE_ITEMS = 1000;
export const ASIN_BATCH_CREATE_CHUNK_SIZE = 100;
export interface BatchAsinItem {
  index: number;
  id: string;
  asin: string;
  name: string | null;
  asinType: '1' | '2' | null;
  country: string;
  site: string | null;
  brand: string | null;
  parentId: string | null;
}
export interface BatchAsinPlan {
  result: BatchCreateAsinsData;
  items: BatchAsinItem[];
}
const optionalText = (value: unknown) =>
  value == null ? null : String(value).trim() || null;
export const batchCountry = (value: unknown) =>
  value ? String(value).trim().toUpperCase() : '';
const asinType = (value: unknown): '1' | '2' | null => {
  if (!value) return null;
  const type = String(value).trim();
  return type === '1' || type === 'MAIN_LINK'
    ? '1'
    : type === '2' || type === 'SUB_REVIEW'
    ? '2'
    : null;
};
export const batchAsinKey = (item: Pick<BatchAsinItem, 'asin' | 'country'>) =>
  `${item.asin}:${item.country}`;
export const batchDuplicateMessage = (item: BatchAsinItem) =>
  `ASIN ${item.asin} 在国家 ${item.country} 中已存在`;
export function addBatchAsinFailure(
  result: BatchCreateAsinsData,
  item: BatchAsinItem,
  message: string,
) {
  const fields = {
    index: item.index,
    asin: item.asin || null,
    country: item.country || null,
    message,
  };
  result.failedCount++;
  result.results.push({ ...fields, success: false });
  result.errors.push(fields);
}
export function addBatchAsinSuccess(
  result: BatchCreateAsinsData,
  item: BatchAsinItem,
) {
  result.successCount++;
  result.results.push({
    index: item.index,
    id: item.id,
    asin: item.asin,
    country: item.country,
    parentId: item.parentId,
    success: true,
  });
}
/** Keep validation failure phases and result ordering from the actual Legacy service. */
export function prepareBatchAsins(
  items: unknown[],
  idFactory: () => string = randomUUID,
): BatchAsinPlan {
  if (!items.length || items.length > MAX_ASIN_BATCH_CREATE_ITEMS)
    throw new Error('Invalid ASIN batch size');
  const result: BatchCreateAsinsData = {
    total: items.length,
    successCount: 0,
    failedCount: 0,
    results: [],
    errors: [],
  };
  const seen = new Set<string>();
  const valid: BatchAsinItem[] = [];
  items.forEach((value, index) => {
    const raw = (value || {}) as Record<string, unknown>;
    let item: BatchAsinItem;
    try {
      item = {
        index,
        id: idFactory(),
        asin: batchCountry(raw.asin),
        name: optionalText(raw.name),
        asinType: asinType(raw.asinType),
        country: batchCountry(raw.country),
        site: optionalText(raw.site),
        brand: optionalText(raw.brand),
        parentId: optionalText(raw.parentId || raw.variantGroupId),
      };
    } catch {
      // Untrusted JSON objects may shadow toString. Treat only this row as invalid.
      addBatchAsinFailure(
        result,
        {
          index,
          id: '',
          asin: '',
          name: null,
          asinType: null,
          country: '',
          site: null,
          brand: null,
          parentId: null,
        },
        '参数格式无效',
      );
      return;
    }
    const failure = !/^[A-Z0-9]{10}$/.test(item.asin)
      ? 'ASIN编码必须是10位字母数字组合'
      : !item.country
      ? '国家不能为空'
      : !item.site
      ? '站点不能为空'
      : !item.brand
      ? '品牌不能为空'
      : !item.parentId
      ? '所属变体组不能为空'
      : raw.asinType && !item.asinType
      ? 'ASIN类型必须是 1（主链）或 2（副评）'
      : seen.has(batchAsinKey(item))
      ? '请求中存在重复ASIN，已跳过'
      : null;
    if (failure) addBatchAsinFailure(result, item, failure);
    else {
      seen.add(batchAsinKey(item));
      valid.push(item);
    }
  });
  return { result, items: valid };
}
/** PG varchar counts code points; invalid text is a per-row create failure. */
export function batchAsinFitsStorage(item: BatchAsinItem): boolean {
  const fields = [
    [item.name, 500],
    [item.country, 10],
    [item.site, 100],
    [item.brand, 100],
    [item.parentId, 50],
  ] as const;
  return fields.every(
    ([value, max]) =>
      value == null || (!value.includes('\0') && [...value].length <= max),
  );
}
