import {
  AsinImportRepositoryError,
  MAX_ASIN_BATCH_CREATE_ITEMS,
  prepareImportAsins,
  type AsinImportRepositoryPort,
  type ImportChunkResult,
} from '@asin-monitor/db';
import { parseCsvFile } from './csv';
import { ImportFileStore, type ImportFileReference } from './files';
import type { ImportPlan, ImportRowError } from './rows';
import { parseXlsxFile } from './xlsx';

export interface ImportResult {
  total: number;
  processedCount: number;
  successCount: number;
  failedCount: number;
  missingCount: number;
  verificationPassed: boolean;
  errors?: ImportRowError[];
}
export interface ImportControls {
  signal: AbortSignal;
  /** Outside PG transactions: checks queue ownership and requested cancellation. */
  checkpoint?(): Promise<void>;
  onProgress?(progress: number, message: string): Promise<void>;
}

/** Same grouping/validation phases as Legacy. Groups commit independently,
 * followed by bounded ASIN transactions; cancellation prevents subsequent writes. */
export async function executeImportPlan(
  plan: ImportPlan,
  repository: AsinImportRepositoryPort,
  controls: ImportControls,
): Promise<ImportResult> {
  const check = async () => {
    controls.signal.throwIfAborted();
    await controls.checkpoint?.();
    controls.signal.throwIfAborted();
  };
  let lastProgress = -1;
  const progress = async (value: number, message: string) => {
    if (value === lastProgress) return;
    await controls.onProgress?.(value, message);
    lastProgress = value;
  };
  await check();
  await progress(55, '正在写入数据库...');
  const errors = [...plan.errors];
  let successCount = 0;
  let failedCount = errors.length;
  const items: unknown[] = [];
  for (let index = 0; index < plan.groupedItems.length; index++) {
    const group = plan.groupedItems[index];
    await check();
    await progress(
      55 + Math.floor((index / Math.max(plan.groupedItems.length, 1)) * 35),
      `正在处理变体组... (${index + 1}/${plan.groupedItems.length})`,
    );
    let parentId: string;
    try {
      parentId = await repository.transaction(async (unit) => {
        controls.signal.throwIfAborted();
        const id = await unit.findOrCreateImportGroup(group);
        controls.signal.throwIfAborted();
        return id;
      });
    } catch (error) {
      controls.signal.throwIfAborted();
      if (
        !(error instanceof AsinImportRepositoryError) ||
        error.code !== 'invalid-group'
      )
        throw error;
      failedCount += group.asins.length;
      errors.push({
        row: 0,
        message: `创建变体组 ${group.name} (${group.country}) 失败: 变体组参数无效或写入失败`,
      });
      continue;
    }
    for (const asin of group.asins)
      items.push({
        ...asin,
        country: group.country,
        site: asin.site || group.site,
        brand: asin.brand || group.brand,
        parentId,
      });
  }
  await check();
  if (items.length) {
    const prepared = prepareImportAsins(items);
    failedCount += prepared.result.failedCount;
    const batchErrors: ImportChunkResult['errors'] = [];
    const format = (error: { asin?: string | null; message: string }) => ({
      row: 0,
      message: `创建ASIN ${error.asin || ''} 失败: ${error.message}`,
    });
    for (const error of prepared.result.errors) errors.push(format(error));
    for (
      let offset = 0;
      offset < prepared.items.length;
      offset += MAX_ASIN_BATCH_CREATE_ITEMS
    ) {
      await check();
      await progress(
        90 + Math.floor((offset / Math.max(prepared.items.length, 1)) * 9),
        '正在批量写入ASIN...',
      );
      const chunk = prepared.items.slice(
        offset,
        offset + MAX_ASIN_BATCH_CREATE_ITEMS,
      );
      const result = await repository.transaction(async (unit) => {
        controls.signal.throwIfAborted();
        const result = await unit.writeImportChunk(chunk);
        controls.signal.throwIfAborted();
        return result;
      });
      successCount += result.successCount;
      failedCount += result.failedCount;
      for (const error of result.errors) batchErrors.push(error);
    }
    // Preserve the full-file Legacy error phases across transaction boundaries.
    const rank = { group: 0, existing: 1, write: 2 };
    batchErrors.sort(
      (left, right) =>
        rank[left.phase] - rank[right.phase] ||
        (left.index ?? 0) - (right.index ?? 0),
    );
    for (const error of batchErrors) errors.push(format(error));
  }
  await check();
  const processedCount = successCount + failedCount;
  const missingCount = Math.max(plan.totalDataRows - processedCount, 0);
  return {
    total: plan.totalDataRows,
    processedCount,
    successCount,
    failedCount,
    missingCount,
    verificationPassed: missingCount === 0,
    ...(errors.length ? { errors } : {}),
  };
}

export async function importStoredFile(
  file: ImportFileReference,
  storage: ImportFileStore,
  repository: AsinImportRepositoryPort,
  controls: ImportControls,
): Promise<ImportResult> {
  controls.signal.throwIfAborted();
  await controls.checkpoint?.();
  await controls.onProgress?.(5, '正在解析导入文件...');
  const path = await storage.verifiedPath(file, controls.signal);
  const plan = await (file.extension === 'csv' ? parseCsvFile : parseXlsxFile)(
    path,
    { signal: controls.signal },
  );
  await controls.onProgress?.(50, 'Excel解析完成，正在准备写入...');
  return executeImportPlan(plan, repository, controls);
}
