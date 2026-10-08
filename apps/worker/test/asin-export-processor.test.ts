import type { Env } from '@asin-monitor/config';
import type { AsinExportJobData } from '@asin-monitor/contracts';
import {
  transitionTask,
  type AsinExportChildrenCursor,
  type AsinExportCursor,
  type AsinExportQueryRepositoryPort,
  type AsinGroupReadResult,
  type TaskState,
} from '@asin-monitor/db';
import { ExportArtifactError, ExportArtifactStore } from '@asin-monitor/export';
import type { Job } from 'bullmq';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import type { WriteStream } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAsinExportProcessor } from '../src/asin-export-processor';
import {
  ASIN_EXPORT_DETAILED_HEADER as ASIN_EXPORT_HEADER,
  asinExportRows,
} from '../src/asin-export-rows';
import { startAsinExportRuntime } from '../src/asin-export-runtime';

const taskId = '10000000-0000-4000-8000-000000000166';
const createdAt = '2026-09-27T00:00:00.000Z';
const data: AsinExportJobData = {
  taskId,
  userId: 'owner',
  taskType: 'export',
  taskSubType: 'asin',
  exportType: 'asin',
  createdAt,
  params: { country: 'US', layout: 'detailed' },
};
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
  exportIsBroken: broken,
  exportHasAutoBroken: broken,
  exportHasManualBroken: false,
  createTime: new Date('2026-09-26T16:00:00.000Z'),
  exportCursorTime: '2026-09-27 00:00:00.123456',
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
  exportCursorTime: '2026-09-27 00:00:00.123456',
  updateTime: null,
  lastCheckTime: new Date('2026-09-27T01:02:03.000Z'),
});

async function harness(pages: AsinGroupReadResult[], maxBytes?: number) {
  const directory = await mkdtemp(
    join(tmpdir(), `neo-export-${randomUUID()}-`),
  );
  directories.push(directory);
  const artifacts = new ExportArtifactStore(directory, maxBytes);
  let current = state();
  let beforeMutation:
    | ((change: Parameters<typeof transitionTask>[1]) => void)
    | undefined;
  const store = {
    read: vi.fn(async () => current),
    mutate: vi.fn(
      async (_id: string, change: Parameters<typeof transitionTask>[1]) => {
        beforeMutation?.(change);
        current = transitionTask(current, change, new Date());
        return current;
      },
    ),
  };
  let nextPage = 0;
  const list = vi.fn(
    async (
      _query: { current: number },
      _cursor?: AsinExportCursor,
      _includeTotal?: boolean,
    ): Promise<AsinGroupReadResult> => {
      const selected = pages[nextPage++];
      return selected
        ? { ...selected, asins: [] }
        : {
            groups: [],
            asins: [],
            total: pages[0]?.total ?? 0,
            totalASINs: pages[0]?.totalASINs ?? 0,
          };
    },
  );
  const legacyChildren = vi.fn(
    async (groupId: string, cursor?: AsinExportCursor) => {
      const selected = pages
        .flatMap((page) => page.asins)
        .filter((asin) => asin.variantGroupId === groupId);
      const start = cursor
        ? selected.findIndex((asin) => asin.id === cursor.id) + 1
        : 0;
      return selected.slice(start, start + 5000);
    },
  );
  const children = vi.fn(
    async (groupIds: readonly string[], cursor?: AsinExportChildrenCursor) => {
      const selected = groupIds.flatMap((groupId) =>
        pages
          .flatMap((page) => page.asins)
          .filter((asin) => asin.variantGroupId === groupId),
      );
      const start = cursor
        ? selected.findIndex(
            (asin) =>
              asin.id === cursor.id && asin.variantGroupId === cursor.groupId,
          ) + 1
        : 0;
      return selected.slice(start, start + 5000);
    },
  );
  const repository = {
    read: vi.fn(
      async (
        operation: (
          unit: {
            listExportGroups: typeof list;
            listExportChildren: typeof legacyChildren;
            listExportChildrenPage: typeof children;
          },
          ensureOpen: () => void,
        ) => Promise<unknown>,
      ) =>
        operation(
          {
            listExportGroups: list,
            listExportChildren: legacyChildren,
            listExportChildrenPage: children,
          },
          () => undefined,
        ),
    ),
  } as unknown as AsinExportQueryRepositoryPort;
  const options = {
    shutdownSignal: new AbortController().signal,
    isClosing: () => false,
    assertJobLock: vi.fn(async () => undefined),
    updateProgress: vi.fn(async () => undefined),
    now: vi.fn(() => new Date('2026-09-27T16:01:00.000Z')),
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
    children,
    legacyChildren,
    repository,
    options,
    processor,
    get state() {
      return current;
    },
    setState(next: TaskState) {
      current = next;
    },
    onMutation(hook: (change: Parameters<typeof transitionTask>[1]) => void) {
      beforeMutation = hook;
    },
  };
}

describe('ASIN streaming export', () => {
  it.each(['cancelling', 'cancelled'] as const)(
    'removes an earlier attempt artifact when %s is observed before reading it',
    async (status) => {
      const h = await harness([]);
      h.onMutation((change) => {
        if (change.kind === 'completed') throw new Error('fixture-ack-lost');
      });
      await expect(h.processor(h.job, 'token')).rejects.toThrow(
        'EXPORT_COMPLETION_UNCONFIRMED',
      );
      expect(await h.artifacts.read(taskId)).not.toBeNull();
      const neighbour = randomUUID();
      const temporary = await h.artifacts.temporary(neighbour);
      temporary.stream.end(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]));
      await finished(temporary.stream);
      await h.artifacts.publish(
        neighbour,
        temporary.path,
        new AbortController().signal,
      );
      await h.artifacts.discard(temporary.path);
      h.setState({
        ...h.state,
        status,
        cancelRequestedAt: createdAt,
        cancelledAt: status === 'cancelled' ? createdAt : null,
      });
      h.onMutation(() => undefined);
      const read = vi.spyOn(h.artifacts, 'read');
      const previousQueries = h.list.mock.calls.length;
      h.job.attemptsMade = 1;
      await expect(h.processor(h.job, 'token')).resolves.toMatchObject({
        cancelled: true,
      });
      expect(read).not.toHaveBeenCalled();
      expect(h.state.status).toBe('cancelled');
      expect(h.list).toHaveBeenCalledTimes(previousQueries);
      expect(await h.artifacts.read(taskId)).toBeNull();
      expect(await h.artifacts.read(neighbour)).not.toBeNull();
    },
  );

  it.each(['completed', 'foreign'] as const)(
    'retains an earlier artifact when the retry sees a %s task',
    async (boundary) => {
      const h = await harness([]);
      h.onMutation((change) => {
        if (change.kind === 'completed') throw new Error('fixture-ack-lost');
      });
      await expect(h.processor(h.job, 'token')).rejects.toThrow(
        'EXPORT_COMPLETION_UNCONFIRMED',
      );
      const artifact = await h.artifacts.read(taskId);
      h.setState({
        ...h.state,
        ...(boundary === 'completed'
          ? { status: 'completed' as const, result: { artifact } }
          : { userId: 'another-owner', status: 'cancelled' as const }),
      });
      const remove = vi.spyOn(h.artifacts, 'discardFinal');
      h.job.attemptsMade = 1;
      const attempt = h.processor(h.job, 'token');
      if (boundary === 'completed')
        await expect(attempt).resolves.toEqual({ artifact });
      else await expect(attempt).rejects.toThrow('ASIN_EXPORT_ATTEMPT_FAILED');
      expect(remove).not.toHaveBeenCalled();
      expect(await h.artifacts.read(taskId)).toEqual(artifact);
    },
  );

  it.each(['deadline', 'cancellation', 'shutdown'] as const)(
    'interrupts stalled XLSX finalization on %s, closes the real stream and prevents late publication',
    async (reason) => {
      const h = await harness([]);
      h.job.opts.attempts = 1;
      const shutdown = new AbortController();
      h.options.shutdownSignal = shutdown.signal;
      let stream!: WriteStream;
      const temporary = h.artifacts.temporary.bind(h.artifacts);
      vi.spyOn(h.artifacts, 'temporary').mockImplementation(async (id) => {
        const result = await temporary(id);
        stream = result.stream;
        return result;
      });
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let finish!: () => void;
      vi.spyOn(
        ExcelJS.stream.xlsx.WorkbookWriter.prototype,
        'commit',
      ).mockImplementation(async () => {
        entered();
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      });
      const publish = vi.spyOn(h.artifacts, 'publish');
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
      });
      const attempt = h.processor(h.job, 'token');
      const settled =
        reason === 'cancellation'
          ? expect(attempt).resolves.toMatchObject({ cancelled: true })
          : expect(attempt).rejects.toThrow('ASIN_EXPORT_ATTEMPT_FAILED');
      await started;
      if (reason === 'deadline') await vi.advanceTimersByTimeAsync(30 * 60_000);
      else if (reason === 'cancellation') {
        h.setState({
          ...h.state,
          status: 'cancelling',
          cancelRequestedAt: createdAt,
        });
        await vi.advanceTimersByTimeAsync(1000);
      } else shutdown.abort();
      await settled;
      expect(stream.destroyed).toBe(true);
      expect(stream.closed).toBe(true);
      expect(h.state.status).toBe(
        reason === 'cancellation' ? 'cancelled' : 'failed',
      );
      expect(await readdir(h.directory)).toEqual([]);
      finish();
      await Promise.resolve();
      await Promise.resolve();
      expect(publish).not.toHaveBeenCalled();
      expect(await h.artifacts.read(taskId)).toBeNull();
    },
  );

  it('releases a timed-out attempt when filesystem close stalls and cleans only after actual close', async () => {
    const h = await harness([]);
    h.job.opts.attempts = 1;
    const shutdown = new AbortController();
    h.options.shutdownSignal = shutdown.signal;
    let stream!: WriteStream;
    let releaseClose!: () => void;
    const temporary = h.artifacts.temporary.bind(h.artifacts);
    vi.spyOn(h.artifacts, 'temporary').mockImplementation(async (id) => {
      const result = await temporary(id);
      stream = result.stream;
      const destroy = stream._destroy.bind(stream);
      vi.spyOn(stream, '_destroy').mockImplementation((error, callback) => {
        releaseClose = () => destroy(error, callback);
      });
      // This fixture stalls close, not the asynchronous open before _destroy.
      // Wait for the real descriptor so load cannot defer the injected boundary.
      if (stream.pending)
        await new Promise<void>((resolve, reject) => {
          stream.once('open', () => resolve());
          stream.once('error', reject);
        });
      return result;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let finish!: () => void;
    vi.spyOn(
      ExcelJS.stream.xlsx.WorkbookWriter.prototype,
      'commit',
    ).mockImplementation(async () => {
      entered();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const publish = vi.spyOn(h.artifacts, 'publish');
    const discard = vi.spyOn(h.artifacts, 'discard');
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    });
    const attempt = h.processor(h.job, 'token');
    const rejected = expect(attempt).rejects.toThrow(
      'ASIN_EXPORT_ATTEMPT_FAILED',
    );
    await started;
    shutdown.abort();
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(stream.closed).toBe(false);
    expect(discard).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    const closed = new Promise<void>((resolve) =>
      stream.once('close', resolve),
    );
    releaseClose();
    await closed;
    vi.useRealTimers();
    await vi.waitFor(async () =>
      expect(await readdir(h.directory)).toEqual([]),
    );
    expect(discard).toHaveBeenCalledOnce();
    finish();
    await Promise.resolve();
    expect(publish).not.toHaveBeenCalled();
  });

  it('interrupts finished() after commit has returned without publishing the unfinished stream', async () => {
    const h = await harness([]);
    h.job.opts.attempts = 1;
    const shutdown = new AbortController();
    h.options.shutdownSignal = shutdown.signal;
    let stream!: WriteStream;
    const temporary = h.artifacts.temporary.bind(h.artifacts);
    vi.spyOn(h.artifacts, 'temporary').mockImplementation(async (id) => {
      const output = await temporary(id);
      stream = output.stream;
      return output;
    });
    const commit = vi
      .spyOn(ExcelJS.stream.xlsx.WorkbookWriter.prototype, 'commit')
      .mockResolvedValue(undefined);
    const publish = vi.spyOn(h.artifacts, 'publish');
    const attempt = h.processor(h.job, 'token');
    const rejected = expect(attempt).rejects.toThrow(
      'ASIN_EXPORT_ATTEMPT_FAILED',
    );
    await vi.waitFor(() => {
      expect(commit).toHaveBeenCalledOnce();
      expect(stream.listenerCount('finish')).toBeGreaterThan(0);
    });
    expect(stream.writableFinished).toBe(false);
    shutdown.abort();
    try {
      expect(stream.destroyed).toBe(true);
    } finally {
      // Even a deliberately regressed processor must release this real fd.
      if (!stream.destroyed) stream.destroy(new Error('fixture shutdown'));
      await rejected;
    }
    expect(stream.closed).toBe(true);
    expect(publish).not.toHaveBeenCalled();
    expect(await readdir(h.directory)).toEqual([]);
  });

  it('fails and cleans the actual temporary file when streaming crosses the byte limit', async () => {
    const h = await harness(
      [
        {
          groups: [group('g1', 'Bounded')],
          asins: [asin('B000000001', 'g1')],
          total: 1,
          totalASINs: 1,
        },
      ] as unknown as AsinGroupReadResult[],
      64,
    );
    const publish = vi.spyOn(h.artifacts, 'publish');
    await expect(h.processor(h.job, 'token')).rejects.toThrow('超过上限');
    expect(h.state.status).toBe('failed');
    expect(h.state.message).toBe('ASIN 导出超过上限，请缩小筛选范围');
    expect(publish).not.toHaveBeenCalled();
    expect(await readdir(h.directory)).toEqual([]);
    expect(await h.artifacts.read(taskId)).toBeNull();
  });

  it('rejects metadata TTL below the bounded queue and worker lifetime', async () => {
    await expect(
      startAsinExportRuntime(
        { AUTH_DATA_AUTHORITY: 'postgresql', TASK_META_TTL_SECONDS: 60 } as Env,
        vi.fn(),
      ),
    ).rejects.toThrow('at least 6 days');
  });

  it('matches the fixed Legacy fifteen-column fixture across PostgreSQL pages', async () => {
    const pages = [
      {
        groups: [
          {
            ...group('g1', 'Broken', true),
            manualBroken: true,
            manualBrokenReason: '组人工原因',
            exportHasManualBroken: true,
          },
        ],
        asins: [
          {
            ...asin('B000000001', 'g1', true),
            manualBroken: true,
            manualBrokenReason: 'ASIN 人工原因',
          },
        ],
        total: 2,
        totalASINs: 1,
      },
      { groups: [group('g2', 'Empty')], asins: [], total: 2, totalASINs: 1 },
    ] as unknown as AsinGroupReadResult[];
    const h = await harness(pages);
    await h.processor(h.job, 'token');
    expect(h.state.status).toBe('completed');
    expect(h.repository.read).toHaveBeenCalledOnce();
    expect(h.list).toHaveBeenCalledTimes(3);
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
          { length: 15 },
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
        'AUTO+MANUAL',
        'B000000001',
        'Name B000000001',
        '1',
        '异常',
        'AUTO+MANUAL',
        'ASIN 人工原因',
        new Date('2026-09-26T16:00:00.000Z'),
        new Date('2026-09-27T01:02:03.000Z'),
      ],
      [
        'Empty',
        'g2',
        'US',
        'amazon.com',
        'Fixture',
        '正常',
        'NORMAL',
        '',
        '',
        '',
        '',
        '',
        '',
        new Date('2026-09-26T16:00:00.000Z'),
        '',
      ],
    ]);
    expect(h.state.result).toMatchObject({
      filename: 'ASIN数据_2026-09-28.xlsx',
    });
    expect(
      (await readdir(h.directory)).filter((name) => name.endsWith('.part')),
    ).toEqual([]);
    await h.processor(h.job, 'token');
    expect(h.list).toHaveBeenCalledTimes(3);
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
    expect(h.list).toHaveBeenCalledTimes(4);
    expect(h.children).toHaveBeenCalledTimes(3);
    expect(h.legacyChildren).not.toHaveBeenCalled();
    expect(
      (await readdir(h.directory)).filter((name) => name.endsWith('.part')),
    ).toEqual([]);
  });

  it('continues a single group across the 5,000-child database page', async () => {
    const asins = Array.from({ length: 5001 }, (_, index) =>
      asin(`B${String(index).padStart(9, '0')}`, 'g-dense'),
    );
    const h = await harness([
      {
        groups: [group('g-dense', 'Dense')],
        asins,
        total: 1,
        totalASINs: 5001,
      },
    ] as unknown as AsinGroupReadResult[]);
    await h.processor(h.job, 'token');
    expect(h.state.status).toBe('completed');
    expect(h.state.result).toMatchObject({ rowCount: 5001 });
    expect(h.children).toHaveBeenCalledWith(['g-dense'], undefined);
    expect(h.children).toHaveBeenCalledWith(['g-dense'], {
      groupId: 'g-dense',
      id: asins[4999]!.id,
      createTime: asins[4999]!.exportCursorTime,
    });
  });

  it.each(['empty', 'small'] as const)(
    'batches all fifty %s groups with one child query and preserves Legacy group order',
    async (kind) => {
      const groups = Array.from({ length: 50 }, (_, index) =>
        group(`g-${49 - index}`, `Group ${index}`),
      );
      const asins =
        kind === 'empty'
          ? []
          : groups.map((g, index) =>
              asin(`B${String(index).padStart(9, '0')}`, g.id),
            );
      const h = await harness([
        { groups, asins, total: 50, totalASINs: asins.length },
      ] as unknown as AsinGroupReadResult[]);
      await h.processor(h.job, 'token');
      expect(h.state.status).toBe('completed');
      expect(h.state.result).toMatchObject({ rowCount: 50 });
      expect(h.children).toHaveBeenCalledExactlyOnceWith(
        groups.map((g) => g.id),
        undefined,
      );
      expect(h.legacyChildren).not.toHaveBeenCalled();
      const artifact = (
        h.state.result as {
          artifact: Parameters<typeof h.artifacts.verifiedPath>[0];
        }
      ).artifact;
      const book = new ExcelJS.Workbook();
      await book.xlsx.readFile(
        await h.artifacts.verifiedPath(artifact, new AbortController().signal),
      );
      const sheet = book.worksheets[0]!;
      expect(
        Array.from(
          { length: 50 },
          (_, i) => sheet.getRow(i + 2).getCell(2).value,
        ),
      ).toEqual(groups.map((g) => g.id));
    },
  );

  it('exports the supported 10,000 empty groups in 200 bounded child queries', async () => {
    const pages = Array.from({ length: 200 }, (_, page) => ({
      groups: Array.from({ length: 50 }, (_, index) =>
        group(`g-${page * 50 + index}`, `Group ${page * 50 + index}`),
      ),
      asins: [],
      total: 10_000,
      totalASINs: 0,
    })) as unknown as AsinGroupReadResult[];
    const h = await harness(pages);
    await h.processor(h.job, 'token');
    expect(h.state.status).toBe('completed');
    expect(h.state.result).toMatchObject({ rowCount: 10_000 });
    expect(h.repository.read).toHaveBeenCalledTimes(1);
    expect(h.list).toHaveBeenCalledTimes(201);
    expect(h.children).toHaveBeenCalledTimes(200);
    expect(h.legacyChildren).not.toHaveBeenCalled();
    expect(h.children.mock.calls.every(([ids]) => ids.length === 50)).toBe(
      true,
    );
    const artifact = (
      h.state.result as {
        artifact: Parameters<typeof h.artifacts.verifiedPath>[0];
      }
    ).artifact;
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(
      await h.artifacts.verifiedPath(artifact, new AbortController().signal),
    );
    const sheet = book.worksheets[0]!;
    expect(sheet.rowCount).toBe(10_001);
    expect(sheet.getRow(2).getCell(2).value).toBe('g-0');
    expect(sheet.getRow(10_001).getCell(2).value).toBe('g-9999');
  });

  it('continues a dense group into later small and empty siblings in two bounded queries', async () => {
    const groups = [
      group('z-dense', 'Dense'),
      group('empty', 'Empty'),
      group('a-small', 'Small'),
    ];
    const dense = Array.from({ length: 5001 }, (_, index) =>
      asin(`D${String(index).padStart(9, '0')}`, 'z-dense'),
    );
    const h = await harness([
      {
        groups,
        asins: [...dense, asin('B000000174', 'a-small')],
        total: 3,
        totalASINs: 5002,
      },
    ] as unknown as AsinGroupReadResult[]);
    await h.processor(h.job, 'token');
    expect(h.state.result).toMatchObject({ rowCount: 5003 });
    expect(h.children).toHaveBeenCalledTimes(2);
    expect(h.children).toHaveBeenLastCalledWith(
      ['z-dense', 'empty', 'a-small'],
      {
        groupId: 'z-dense',
        id: dense[4999]!.id,
        createTime: dense[4999]!.exportCursorTime,
      },
    );
    expect(h.legacyChildren).not.toHaveBeenCalled();
    const artifact = (
      h.state.result as {
        artifact: Parameters<typeof h.artifacts.verifiedPath>[0];
      }
    ).artifact;
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(
      await h.artifacts.verifiedPath(artifact, new AbortController().signal),
    );
    expect(book.worksheets[0]!.getRow(5003).getCell(2).value).toBe('empty');
    expect(book.worksheets[0]!.getRow(5004).getCell(2).value).toBe('a-small');
  });

  it('keeps group status source stable across child pages', async () => {
    const asins = Array.from({ length: 5001 }, (_, index) => ({
      ...asin(`B${String(index).padStart(9, '0')}`, 'g-dense'),
      manualBroken: index === 0,
      manualBrokenReason: index === 0 ? '人工原因' : null,
    }));
    const h = await harness([
      {
        groups: [{ ...group('g-dense', 'Dense'), exportHasManualBroken: true }],
        asins,
        total: 1,
        totalASINs: 5001,
      },
    ] as unknown as AsinGroupReadResult[]);
    await h.processor(h.job, 'token');
    const ref = (
      h.state.result as {
        artifact: {
          taskId: string;
          key: string;
          bytes: number;
          sha256: string;
        };
      }
    ).artifact;
    const path = await h.artifacts.verifiedPath(
      ref,
      new AbortController().signal,
    );
    const book = new ExcelJS.Workbook();
    await book.xlsx.readFile(path);
    const sheet = book.worksheets[0]!;
    expect(sheet.getRow(2).getCell(7).value).toBe('MANUAL');
    expect(sheet.getRow(5002).getCell(7).value).toBe('MANUAL');
  });

  it('uses the last group as a cursor and keeps reading past an earlier count', async () => {
    const first = group('g-1', 'First');
    const next = group('g-2', 'Next');
    const h = await harness([
      { groups: [first], asins: [], total: 1, totalASINs: 100_001 },
      { groups: [next], asins: [], total: 0, totalASINs: 0 },
    ] as unknown as AsinGroupReadResult[]);
    await h.processor(h.job, 'token');
    expect(h.state.result).toMatchObject({ rowCount: 2 });
    expect(h.list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ current: 1 }),
      { id: first.id, createTime: first.exportCursorTime },
      false,
    );
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

  it('does not publish a writer when the snapshot fails after all rows were read', async () => {
    const h = await harness([
      {
        groups: [group('g1', 'One')],
        asins: [asin('B000000001', 'g1')],
        total: 1,
        totalASINs: 1,
      },
    ] as unknown as AsinGroupReadResult[]);
    const original = h.repository.read.bind(h.repository);
    vi.spyOn(h.repository, 'read').mockImplementationOnce(
      async (operation, signal) => {
        await original(operation, signal);
        throw new Error('ASIN_EXPORT_QUERY_TIMEOUT');
      },
    );
    const publish = vi.spyOn(h.artifacts, 'publish');
    await expect(h.processor(h.job, 'token')).rejects.toThrow(
      'ASIN_EXPORT_ATTEMPT_FAILED',
    );
    expect(publish).not.toHaveBeenCalled();
    expect(await readdir(h.directory)).toEqual([]);
  });

  it('keeps cancellation when it arrives after the final check but before completion CAS', async () => {
    const h = await harness([]);
    h.onMutation((change) => {
      if (change.kind === 'completed') {
        h.setState(
          transitionTask(h.state, { kind: 'cancel-request' }, new Date()),
        );
      }
    });
    await h.processor(h.job, 'token');
    expect(h.state).toMatchObject({
      status: 'cancelled',
      result: null,
    });
    expect(await readdir(h.directory)).toEqual([]);
  });

  it('fails an oversized published artifact without a retry', async () => {
    const h = await harness([]);
    vi.spyOn(h.artifacts, 'publish').mockRejectedValueOnce(
      new ExportArtifactError('too-large'),
    );
    await expect(h.processor(h.job, 'token')).rejects.toThrow(
      'ASIN 导出超过上限',
    );
    expect(h.state.status).toBe('failed');
    expect(h.state.message).toBe('ASIN 导出超过上限，请缩小筛选范围');
    expect(h.list).toHaveBeenCalledTimes(1);
    expect(await readdir(h.directory)).toEqual([]);
  });

  it.each([32767, 32768])(
    'enforces the actual XLSX cell limit at %i characters',
    async (length) => {
      const name = '=literal ' + 'x'.repeat(length - 9);
      const h = await harness([
        { groups: [group('wide', name)], asins: [], total: 1, totalASINs: 0 },
      ] as unknown as AsinGroupReadResult[]);
      if (length > 32767) {
        await expect(h.processor(h.job, 'token')).rejects.toThrow(
          'ASIN 导出超过上限',
        );
        expect(h.state.status).toBe('failed');
        expect(h.state.message).toBe('ASIN 导出超过上限，请缩小筛选范围');
        expect(await readdir(h.directory)).toEqual([]);
      } else {
        await h.processor(h.job, 'token');
        const ref = await h.artifacts.read(taskId);
        const path = await h.artifacts.verifiedPath(
          ref!,
          new AbortController().signal,
        );
        const book = new ExcelJS.Workbook();
        await book.xlsx.readFile(path);
        expect(book.worksheets[0]!.getRow(2).getCell(1).value).toBe(name);
      }
    },
  );

  it('keeps cancellation when it arrives between a capacity failure read and CAS', async () => {
    const h = await harness([
      { groups: [], asins: [], total: 10_001, totalASINs: 0 },
    ] as unknown as AsinGroupReadResult[]);
    h.onMutation((change) => {
      if (change.kind === 'failed') {
        h.setState(
          transitionTask(h.state, { kind: 'cancel-request' }, new Date()),
        );
      }
    });
    await expect(h.processor(h.job, 'token')).resolves.toMatchObject({
      cancelled: true,
    });
    expect(h.state).toMatchObject({ status: 'cancelled', error: null });
    expect(await readdir(h.directory)).toEqual([]);
  });
});

it('preserves Legacy direct-export Date instants before the streaming writer', () => {
  const rows = [
    ...asinExportRows(
      [
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
      ],
      'detailed',
    ),
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
      '',
      '',
      '',
      new Date('2026-09-26T16:00:00.000Z'),
      '',
    ],
  ]);
});
