import {
  AsinImportRepositoryError,
  type AsinImportRepositoryPort,
  type AsinImportUnit,
  type BatchAsinItem,
} from '@asin-monitor/db';
import { describe, expect, it, vi } from 'vitest';
import { executeImportPlan } from '../src/flow';
import { ImportPlanBuilder } from '../src/rows';

function plan(count: number, extra: string[][] = []) {
  const builder = new ImportPlanBuilder([
    '变体组名称',
    '国家',
    '站点',
    '品牌',
    'ASIN',
    'ASIN类型',
  ]);
  for (let i = 0; i < count; i++)
    builder.add(i + 2, [
      'Group',
      'US',
      'Shop',
      'Brand',
      `B${i.toString().padStart(9, '0')}`,
      '1',
    ]);
  extra.forEach((cells, index) => builder.add(count + 2 + index, cells));
  return builder.finish();
}
function repository() {
  const groups = vi.fn(async (group: { name: string }) => `id-${group.name}`);
  const writes = vi.fn(async (items: BatchAsinItem[]) => ({
    successCount: items.length,
    failedCount: 0,
    errors: [],
  }));
  const unit = {
    findOrCreateImportGroup: groups,
    writeImportChunk: writes,
  } as unknown as AsinImportUnit;
  const port: AsinImportRepositoryPort = {
    transaction: async (operation) => operation(unit),
  };
  return { groups, writes, port };
}
describe('shared API/Worker import write flow', () => {
  it('deduplicates across groups before splitting writes and omits empty error properties', async () => {
    const repo = repository();
    const result = await executeImportPlan(
      plan(1001, [['Other', 'US', 'Shop', 'Brand', 'B000000000', '2']]),
      repo.port,
      { signal: AbortSignal.timeout(5000) },
    );
    expect(repo.writes.mock.calls.map(([items]) => items.length)).toEqual([
      1000, 1,
    ]);
    expect(result).toMatchObject({
      total: 1002,
      successCount: 1001,
      failedCount: 1,
      processedCount: 1002,
      missingCount: 0,
      verificationPassed: true,
    });
    expect(result.errors).toEqual([
      {
        row: 0,
        message: '创建ASIN B000000000 失败: 请求中存在重复ASIN，已跳过',
      },
    ]);
    const success = await executeImportPlan(plan(1), repo.port, {
      signal: AbortSignal.timeout(5000),
    });
    expect(Object.hasOwn(success, 'errors')).toBe(false);
  });
  it('counts every ASIN in a failed group while retaining one safe group error', async () => {
    const repo = repository();
    repo.groups.mockRejectedValueOnce(
      new AsinImportRepositoryError('invalid-group'),
    );
    const result = await executeImportPlan(
      plan(2, [['', 'US', '', '', 'bad', '3']]),
      repo.port,
      { signal: AbortSignal.timeout(5000) },
    );
    expect(result).toMatchObject({
      total: 3,
      successCount: 0,
      failedCount: 3,
      processedCount: 3,
      missingCount: 0,
    });
    expect(result.errors).toHaveLength(2);
    expect(result.errors?.[0].row).toBe(4);
    expect(repo.writes).not.toHaveBeenCalled();
  });
  it('preserves full-file database error phases across chunks', async () => {
    const repo = repository();
    const unit = {
      findOrCreateImportGroup: repo.groups,
      writeImportChunk: async (items: BatchAsinItem[]) => {
        const errors =
          items[0].index === 0
            ? [
                {
                  index: 1,
                  asin: 'B000000001',
                  message: 'existing',
                  phase: 'existing' as const,
                },
                {
                  index: 2,
                  asin: 'B000000002',
                  message: 'write',
                  phase: 'write' as const,
                },
              ]
            : [
                {
                  index: 1001,
                  asin: 'B000001001',
                  message: 'group',
                  phase: 'group' as const,
                },
              ];
        return {
          successCount: items.length - errors.length,
          failedCount: errors.length,
          errors,
        };
      },
    } as unknown as AsinImportUnit;
    const result = await executeImportPlan(
      plan(1002),
      { transaction: async (action) => action(unit) },
      { signal: AbortSignal.timeout(5000) },
    );
    expect(result.errors?.map((error) => error.message)).toEqual([
      '创建ASIN B000001001 失败: group',
      '创建ASIN B000000001 失败: existing',
      '创建ASIN B000000002 失败: write',
    ]);
    expect(result.failedCount).toBe(3);
    expect(result.verificationPassed).toBe(true);
  });
  it('stops after committed chunks when cancellation is observed at the next checkpoint', async () => {
    const repo = repository();
    const controller = new AbortController();
    await expect(
      executeImportPlan(plan(1001), repo.port, {
        signal: controller.signal,
        checkpoint: async () => {
          if (repo.writes.mock.calls.length) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(repo.writes).toHaveBeenCalledTimes(1);
  });
  it('propagates storage/connection and lease failures before starting subsequent writes', async () => {
    const repo = repository();
    repo.groups.mockRejectedValueOnce(new Error('fixture connection lost'));
    await expect(
      executeImportPlan(plan(2), repo.port, {
        signal: AbortSignal.timeout(5000),
      }),
    ).rejects.toThrow('fixture connection lost');
    expect(repo.writes).not.toHaveBeenCalled();
    await expect(
      executeImportPlan(plan(2), repo.port, {
        signal: AbortSignal.timeout(5000),
        checkpoint: async () => {
          throw new Error('fixture lease lost');
        },
      }),
    ).rejects.toThrow('fixture lease lost');
    expect(repo.groups).toHaveBeenCalledTimes(1);
  });
});
