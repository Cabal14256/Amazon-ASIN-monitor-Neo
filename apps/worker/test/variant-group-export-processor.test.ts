import type { VariantGroupExportJobData } from '@asin-monitor/contracts';
import {
  transitionTask,
  type AsinExportQueryUnit,
  type TaskState,
} from '@asin-monitor/db';
import { ExportArtifactStore } from '@asin-monitor/export';
import ExcelJS from 'exceljs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createVariantGroupExportProcessor } from '../src/variant-group-export-processor';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function variantGroup(id: string, name: string, isBroken: boolean) {
  return {
    id,
    name,
    country: 'US',
    site: 'amazon.com',
    brand: 'Fixture',
    isBroken,
    manualBroken: false,
    manualBrokenReason: null,
    manualBrokenUpdatedAt: null,
    manualBrokenUpdatedBy: null,
    createTime: new Date('2026-09-27T00:00:00.000Z'),
    updateTime: null,
    lastCheckTime: null,
    feishuNotifyEnabled: true,
    exportIsBroken: isBroken,
    exportHasAutoBroken: isBroken,
    exportHasManualBroken: false,
    exportCursorTime: '2026-09-27 00:00:00.000',
  };
}

describe('variant-group export processor', () => {
  it('writes the Legacy task workbook from one bounded group snapshot', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'neo-variant-group-export-'),
    );
    directories.push(directory);
    const artifacts = new ExportArtifactStore(directory);
    const data: VariantGroupExportJobData = {
      taskId: '10000000-0000-4000-8000-000000000210',
      userId: 'variant-group-export-owner',
      taskType: 'export',
      taskSubType: 'variant-group',
      exportType: 'variant-group',
      createdAt: '2026-09-27T00:00:00.000Z',
      params: { country: 'US' },
    };
    let state: TaskState = {
      taskId: data.taskId,
      userId: data.userId,
      taskType: data.taskType,
      taskSubType: data.taskSubType,
      title: '变体组导出',
      status: 'pending',
      progress: 0,
      message: '',
      error: null,
      result: null,
      createdAt: data.createdAt,
      updatedAt: data.createdAt,
      startedAt: null,
      completedAt: null,
      cancelRequestedAt: null,
      cancelledAt: null,
      revision: 0,
    };
    const groups = [
      variantGroup('group-broken', 'Broken group', true),
      variantGroup('group-empty', 'Empty group', false),
    ];
    const children = [
      {
        id: 'child-one',
        asin: 'B000000001',
        name: 'Broken child',
        asinType: '1',
        country: 'US',
        site: 'amazon.com',
        brand: 'Fixture',
        variantGroupId: 'group-broken',
        isBroken: true,
        manualBroken: false,
        manualBrokenReason: null,
        manualBrokenUpdatedAt: null,
        manualBrokenUpdatedBy: null,
        manualExcludedFromGroup: false,
        manualExcludedReason: null,
        manualExcludedUpdatedAt: null,
        manualExcludedUpdatedBy: null,
        createTime: new Date('2026-09-26T16:00:00.000Z'),
        updateTime: null,
        lastCheckTime: null,
        feishuNotifyEnabled: true,
        exportCursorTime: '2026-09-27 00:00:00.000',
      },
    ];
    const listExportGroups = vi.fn(async () => ({
      groups: listExportGroups.mock.calls.length === 1 ? groups : [],
      asins: [],
      total: groups.length,
      totalASINs: children.length,
    }));
    const listExportChildrenPage = vi.fn(async () =>
      listExportChildrenPage.mock.calls.length === 1 ? children : [],
    );
    const repository = {
      read: async <T>(
        run: (unit: AsinExportQueryUnit, ensureOpen: () => void) => Promise<T>,
      ) =>
        run(
          {
            listExportGroups,
            listExportChildrenPage,
          } as unknown as AsinExportQueryUnit,
          () => undefined,
        ),
    };
    const store = {
      read: vi.fn(async () => state),
      mutate: vi.fn(
        async (
          _taskId: string,
          change: Parameters<typeof transitionTask>[1],
        ) => {
          state = transitionTask(
            state,
            change,
            new Date('2026-09-27T02:00:00.000Z'),
          );
          return state;
        },
      ),
    };
    const updateProgress = vi.fn(async () => undefined);
    const processor = createVariantGroupExportProcessor(
      repository as never,
      store as never,
      artifacts,
      {
        shutdownSignal: new AbortController().signal,
        isClosing: () => false,
        assertJobLock: async () => undefined,
        updateProgress,
        now: () => new Date('2026-09-27T16:01:00.000Z'),
      },
    );
    const job = {
      id: data.taskId,
      name: 'variant-group',
      data,
      attemptsMade: 0,
      opts: { attempts: 2 },
    } as never;

    const result = await processor(job, 'fixture-lock');
    expect(state.status).toBe('completed');
    expect(result).toMatchObject({
      exportType: 'variant-group',
      filename: '变体组数据_2026-09-28.xlsx',
      rowCount: 2,
    });
    expect(listExportGroups).toHaveBeenCalledTimes(2);
    expect(listExportChildrenPage).toHaveBeenCalledOnce();
    expect(updateProgress).toHaveBeenCalled();
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(
      await (
        await import('node:fs/promises')
      ).readFile(join(directory, `export-${data.taskId}.xlsx`)),
    );
    const sheet = workbook.worksheets[0]!;
    expect(sheet.name).toBe('变体组数据');
    expect(sheet.rowCount).toBe(3);
    expect(sheet.getRow(1).cellCount).toBe(11);
    expect(sheet.getRow(2).values).toEqual([
      undefined,
      'Broken group',
      'group-broken',
      'US',
      'amazon.com',
      'Fixture',
      '异常',
      1,
      1,
      new Date('2026-09-27T00:00:00.000Z'),
      '',
      '',
    ]);
    expect(sheet.getRow(3).getCell(6).value).toBe('正常');
    expect(sheet.getRow(3).getCell(7).value).toBe(0);
    expect(sheet.getRow(3).getCell(8).value).toBe(0);
    const { readdir } = await import('node:fs/promises');
    expect(
      (await readdir(directory)).filter((name) => name.endsWith('.part')),
    ).toEqual([]);
  });

  it('uses the captured partial path when an output stream closes after the cleanup deadline', async () => {
    const data: VariantGroupExportJobData = {
      taskId: '10000000-0000-4000-8000-000000000211',
      userId: 'variant-group-export-owner',
      taskType: 'export',
      taskSubType: 'variant-group',
      exportType: 'variant-group',
      createdAt: '2026-09-27T00:00:00.000Z',
      params: {},
    };
    let state: TaskState = {
      taskId: data.taskId,
      userId: data.userId,
      taskType: data.taskType,
      taskSubType: data.taskSubType,
      title: '变体组导出',
      status: 'pending',
      progress: 0,
      message: '',
      error: null,
      result: null,
      createdAt: data.createdAt,
      updatedAt: data.createdAt,
      startedAt: null,
      completedAt: null,
      cancelRequestedAt: null,
      cancelledAt: null,
      revision: 0,
    };
    let releaseClose: ((error?: Error | null) => void) | undefined;
    const stream = new Writable({
      write(_chunk, _encoding, callback) {
        callback();
      },
      destroy(error, callback) {
        releaseClose = () => callback(error);
      },
    });
    const partialPath = join(tmpdir(), 'variant-group-delayed-close.part');
    const discard = vi.fn(async () => undefined);
    const artifacts = {
      read: vi.fn(async () => null),
      temporary: vi.fn(async () => ({ path: partialPath, stream })),
      discard,
    };
    const repository = {
      read: async <T>(
        run: (unit: AsinExportQueryUnit, ensureOpen: () => void) => Promise<T>,
      ) =>
        run(
          {
            listExportGroups: async () => {
              throw new Error('fixture query failure');
            },
            listExportChildrenPage: vi.fn(async () => []),
          } as unknown as AsinExportQueryUnit,
          () => undefined,
        ),
    };
    const store = {
      read: vi.fn(async () => state),
      mutate: vi.fn(
        async (
          _taskId: string,
          change: Parameters<typeof transitionTask>[1],
        ) => {
          state = transitionTask(
            state,
            change,
            new Date('2026-09-27T02:00:00.000Z'),
          );
          return state;
        },
      ),
    };
    const processor = createVariantGroupExportProcessor(
      repository as never,
      store as never,
      artifacts as never,
      {
        shutdownSignal: new AbortController().signal,
        isClosing: () => false,
        assertJobLock: async () => undefined,
        updateProgress: vi.fn(async () => undefined),
      },
    );
    const job = {
      id: data.taskId,
      name: 'variant-group',
      data,
      attemptsMade: 0,
      opts: { attempts: 2 },
    } as never;

    const running = processor(job, 'fixture-lock').catch(
      (error: unknown) => error,
    );
    const deadline = Date.now() + 1000;
    while (!releaseClose && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 10));
    expect(releaseClose).toBeTypeOf('function');
    await new Promise((resolve) => setTimeout(resolve, 5200));
    await expect(running).resolves.toBeInstanceOf(Error);
    expect(discard).not.toHaveBeenCalled();

    releaseClose?.(null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(discard).toHaveBeenCalledWith(partialPath);
  }, 15_000);
});
