import type { AsinExportJobData } from '@asin-monitor/contracts';
import {
  transitionTask,
  type AsinGroupReadResult,
  type AsinQueryRepositoryPort,
  type TaskState,
} from '@asin-monitor/db';
import { ExportArtifactStore } from '@asin-monitor/export';
import type { Job } from 'bullmq';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsinExportProcessor } from '../src/asin-export-processor';
import { ASIN_EXPORT_HEADER, asinExportRows } from '../src/asin-export-rows';

const taskId = '10000000-0000-4000-8000-000000000166';
const createdAt = '2026-09-27T00:00:00.000Z';
const data: AsinExportJobData = {
  taskId,
  userId: 'owner',
  taskType: 'export',
  taskSubType: 'asin',
  exportType: 'asin',
  createdAt,
  params: { country: 'US' },
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function state(): TaskState {
  return {
    taskId,
    userId: data.userId,
    taskType: data.taskType,
    taskSubType: data.taskSubType,
    title: 'ASIN导出',
    status: 'pending',
    progress: 0,
    message: '',
    error: null,
    result: null,
    createdAt,
    updatedAt: createdAt,
    startedAt: null,
    completedAt: null,
    cancelRequestedAt: null,
    cancelledAt: null,
    revision: 0,
  };
}

const group = (id: string, name: string, broken = false) => ({
  id,
  name,
  country: 'US',
  site: 'amazon.com',
  brand: 'Fixture',
  isBroken: broken,
  createTime: new Date('2026-09-26T16:00:00.000Z'),
  updateTime: null,
  lastCheckTime: null,
});
const asin = (id: string, parent: string, broken = false) => ({
  id,
  asin: id,
  name: `Name ${id}`,
  asinType: '1',
  country: 'US',
  site: 'amazon.com',
  brand: 'Fixture',
  variantGroupId: parent,
  isBroken: broken,
  createTime: new Date('2026-09-26T16:00:00.000Z'),
  updateTime: null,
  lastCheckTime: new Date('2026-09-27T01:02:03.000Z'),
});

async function harness(pages: AsinGroupReadResult[]) {
  const directory = await mkdtemp(
    join(tmpdir(), `neo-export-${randomUUID()}-`),
  );
  directories.push(directory);
  const artifacts = new ExportArtifactStore(directory);
  let current = state();
  const store = {
    read: vi.fn(async () => current),
    mutate: vi.fn(
      async (_id: string, change: Parameters<typeof transitionTask>[1]) => {
        current = transitionTask(current, change, new Date());
        return current;
      },
    ),
  };
  const list = vi.fn(
    async (query: { current: number }) =>
      pages[query.current - 1] ?? {
        groups: [],
        asins: [],
        total: pages[0]?.total ?? 0,
        totalASINs: pages[0]?.totalASINs ?? 0,
      },
  );
  const repository = {
    read: async (
      operation: (unit: { list: typeof list }) => Promise<unknown>,
    ) => operation({ list }),
  } as unknown as AsinQueryRepositoryPort;
  const options = {
    shutdownSignal: new AbortController().signal,
    isClosing: () => false,
    assertJobLock: vi.fn(async () => undefined),
    updateProgress: vi.fn(async () => undefined),
  };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const processor = createAsinExportProcessor(
    repository,
    store as never,
    artifacts,
    options,
    log,
  );
  const job = {
    id: taskId,
    name: 'asin',
    data,
    attemptsMade: 0,
    opts: { attempts: 2 },
  } as Job;
  return {
    artifacts,
    directory,
    job,
    list,
    options,
    processor,
    get state() {
      return current;
    },
    setState(next: TaskState) {
      current = next;
    },
  };
}

describe('ASIN streaming export', () => {
  it('matches the fixed Legacy twelve-column fixture across PostgreSQL pages', async () => {
    const pages = [
      {
        groups: [group('g1', 'Broken', true)],
        asins: [asin('B000000001', 'g1', true)],
        total: 2,
        totalASINs: 1,
      },
      { groups: [group('g2', 'Empty')], asins: [], total: 2, totalASINs: 1 },
    ] as unknown as AsinGroupReadResult[];
    const h = await harness(pages);
    await h.processor(h.job, 'token');
    expect(h.state.status).toBe('completed');
    expect(h.list).toHaveBeenCalledTimes(2);
    const ref = (
      h.state.result as {
        artifact: {
          bytes: number;
          sha256: string;
          key: string;
          taskId: string;
        };
      }
    ).artifact;
    const path = await h.artifacts.verifiedPath(
      ref,
      new AbortController().signal,
    );
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(path);
    const rows = book.worksheets[0]
      .getSheetValues()
      .slice(1)
      .map((row) =>
        Array.from(
          { length: 12 },
          (_, index) => (row as unknown[])[index + 1] ?? '',
        ),
      );
    expect(rows).toEqual([
      [...ASIN_EXPORT_HEADER],
      [
        'Broken',
        'g1',
        'US',
        'amazon.com',
        'Fixture',
        '异常',
        'B000000001',
        'Name B000000001',
        '1',
        '异常',
        '2026-09-27 00:00:00',
        '2026-09-27 09:02:03',
      ],
      [
        'Empty',
        'g2',
        'US',
        'amazon.com',
        'Fixture',
        '正常',
        '',
        '',
        '',
        '',
        '2026-09-27 00:00:00',
        '',
      ],
    ]);
    expect(
      (await readdir(h.directory)).filter((name) => name.endsWith('.part')),
    ).toEqual([]);
    await h.processor(h.job, 'token');
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it('rejects a stolen task identity and never publishes an artifact', async () => {
    const h = await harness([]);
    h.setState({ ...h.state, userId: 'another-user' });
    await expect(h.processor(h.job, 'token')).rejects.toThrow();
    expect(await readdir(h.directory)).toEqual([]);
  });

  it('writes 6,000 ASIN records across bounded query pages', async () => {
    const pages = Array.from({ length: 3 }, (_, page) => {
      const groups = Array.from({ length: 50 }, (_, groupIndex) =>
        group(`g-${page}-${groupIndex}`, `Group ${page}-${groupIndex}`),
      );
      const asins = groups.flatMap((record, groupIndex) =>
        Array.from({ length: 40 }, (_, childIndex) =>
          asin(
            `B${String(page * 2000 + groupIndex * 40 + childIndex).padStart(
              9,
              '0',
            )}`,
            record.id,
          ),
        ),
      );
      return { groups, asins, total: 150, totalASINs: 6000 };
    }) as unknown as AsinGroupReadResult[];
    const h = await harness(pages);
    await h.processor(h.job, 'token');
    expect(h.state.status).toBe('completed');
    expect(h.state.result).toMatchObject({ rowCount: 6000 });
    expect(h.list).toHaveBeenCalledTimes(3);
    expect(
      (await readdir(h.directory)).filter((name) => name.endsWith('.part')),
    ).toEqual([]);
  });

  it('cleans an interrupted partial and records cancellation', async () => {
    const h = await harness([
      { groups: [group('g1', 'One')], asins: [], total: 1, totalASINs: 0 },
    ] as unknown as AsinGroupReadResult[]);
    h.list.mockImplementationOnce(async () => {
      h.setState(
        transitionTask(h.state, { kind: 'cancel-request' }, new Date()),
      );
      return {
        groups: [group('g1', 'One')],
        asins: [],
        total: 1,
        totalASINs: 0,
      } as unknown as AsinGroupReadResult;
    });
    await h.processor(h.job, 'token');
    expect(h.state.status).toBe('cancelled');
    expect(await readdir(h.directory)).toEqual([]);
  });
});

it('renders fixed Legacy records with Shanghai wall time before the streaming writer', () => {
  const rows = [
    ...asinExportRows([
      {
        id: 'g',
        name: 'Group',
        country: 'US',
        site: 'amazon.com',
        brand: 'B',
        isBroken: 0,
        createTime: '2026-09-26T16:00:00.000Z',
        children: [],
      } as never,
    ]),
  ];
  expect(rows).toEqual([
    [
      'Group',
      'g',
      'US',
      'amazon.com',
      'B',
      '正常',
      '',
      '',
      '',
      '',
      '2026-09-27 00:00:00',
      '',
    ],
  ]);
});
