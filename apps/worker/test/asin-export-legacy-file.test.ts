import type { AsinExportJobData } from '@asin-monitor/contracts';
import {
  transitionTask,
  type AsinExportQueryRepositoryPort,
  type AsinGroupReadResult,
  type TaskState,
} from '@asin-monitor/db';
import { ExportArtifactStore } from '@asin-monitor/export';
import type { Job } from 'bullmq';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { createAsinExportProcessor } from '../src/asin-export-processor';

// May be run from Temp before copying into apps/worker/test. All source files
// are read unchanged and only temp XLSX artifacts are written.
const repo =
  process.env.NEO_EXPORT_AUDIT_REPO ?? resolve(__dirname, '../../..');
const legacyRequire = createRequire(join(repo, 'server/package.json'));
const excelRequire = createRequire(
  legacyRequire.resolve('exceljs/package.json'),
);
const JSZip = excelRequire('jszip') as {
  loadAsync(bytes: Buffer): Promise<{
    file(name: string): { async(type: 'string'): Promise<string> };
  }>;
};
const Packet = legacyRequire(
  './node_modules/mysql2/lib/packets/packet.js',
) as new (id: number, bytes: Buffer, start: number, end: number) => {
  parseDateTime(timezone: string): Date;
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function mysqlDate(wall: string): Date {
  const text = Buffer.from(wall);
  const bytes = Buffer.concat([
    Buffer.alloc(4),
    Buffer.from([text.length]),
    text,
  ]);
  const value = new Packet(0, bytes, 0, bytes.length).parseDateTime('+08:00');
  expect(value).toBeInstanceOf(Date);
  return value;
}
function fixture() {
  const created = mysqlDate('2026-09-27 00:00:00.123');
  const checked = mysqlDate('2026-09-27 09:02:03.456');
  const group = {
    id: ' Raw-É ',
    name: '手工与自动异常组',
    country: 'US',
    site: 'amazon.com',
    brand: 'Fixture',
    isBroken: true,
    manualBroken: true,
    manualBrokenReason: '组人工原因',
    createTime: created,
    updateTime: checked,
    lastCheckTime: checked,
    exportCursorTime: '2026-09-27 00:00:00.123000',
    exportIsBroken: true,
    exportHasAutoBroken: true,
    exportHasManualBroken: true,
  };
  const empty = {
    ...group,
    id: 'empty',
    name: '空正常组',
    isBroken: false,
    manualBroken: false,
    manualBrokenReason: null,
    updateTime: null,
    lastCheckTime: null,
    exportIsBroken: false,
    exportHasAutoBroken: false,
    exportHasManualBroken: false,
  };
  const child = {
    id: ' Child-É ',
    asin: 'B00FIXTURE',
    name: '完整记录',
    asinType: '1',
    variantGroupId: group.id,
    country: 'US',
    site: 'amazon.com',
    brand: 'Fixture',
    isBroken: true,
    manualBroken: true,
    manualBrokenReason: 'ASIN 人工原因',
    createTime: created,
    updateTime: checked,
    lastCheckTime: checked,
    exportCursorTime: '2026-09-27 00:00:00.123000',
  };
  // Real Legacy model exports decorated numeric flags and keeps mysql Date.
  // Only field aliases/status fixture values are projected here, never dates.
  const legacy = [
    {
      ...group,
      isBroken: 1,
      statusSource: 'AUTO+MANUAL',
      children: [{ ...child, isBroken: 1, statusSource: 'AUTO+MANUAL' }],
    },
    { ...empty, isBroken: 0, statusSource: 'NORMAL', children: [] },
  ];
  return {
    created,
    checked,
    legacy,
    result: {
      groups: [group, empty],
      asins: [child],
      total: 2,
      totalASINs: 1,
    } as unknown as AsinGroupReadResult,
  };
}

async function legacyFile(
  directory: string,
  groups: unknown[],
  layout: 'task' | 'detailed',
) {
  const quiet = { debug() {}, info() {}, warn() {}, error() {} };
  let output: string | undefined;
  const requireStub = (specifier: string): unknown => {
    if (specifier === 'exceljs') return ExcelJS;
    if (specifier === 'fs')
      return {
        promises: {
          async writeFile(original: string, bytes: Buffer) {
            output = join(directory, `legacy-${basename(original)}`);
            await writeFile(output, bytes);
          },
        },
      };
    if (specifier === 'path' || specifier === 'worker_threads')
      return legacyRequire(specifier);
    if (specifier.includes('/models/'))
      return { findAll: async () => ({ list: groups, total: groups.length }) };
    if (specifier.endsWith('/dateTime'))
      return { getUTC8String: () => '2026-09-27' };
    if (specifier.endsWith('/logger')) return quiet;
    if (specifier.endsWith('taskRegistryService'))
      return { updateTaskProgress: async () => undefined };
    if (specifier.endsWith('websocketService'))
      return { sendTaskProgress() {} };
    if (specifier.endsWith('taskCancellationService'))
      return {
        throwIfTaskCancelled: async () => undefined,
        isTaskCancelledError: () => false,
      };
    return {};
  };
  const sourcePath = join(
    repo,
    layout === 'task'
      ? 'server/src/services/exportTaskProcessor.js'
      : 'server/src/controllers/exportController.js',
  );
  const source = await readFile(sourcePath, 'utf8');
  const module = {
    exports: {} as Record<string, (...args: unknown[]) => Promise<void>>,
  };
  // This VM must share ExcelJS's Array/Date realm. New-context array literals
  // fail ExcelJS row.values instanceof Array, producing an empty false oracle.
  const execute = vm.runInThisContext(
    `(function(require,module,exports,__dirname,process){\n${source}\n${
      layout === 'task' ? 'module.exports.__oracle = processASINExport;' : ''
    }\n})`,
    { filename: sourcePath },
  ) as (...args: unknown[]) => void;
  execute(requireStub, module, module.exports, dirname(sourcePath), {
    env: { EXPORT_WORKER_ENABLED: 'false' },
  });
  if (layout === 'task') {
    await module.exports.__oracle({ progress() {} }, 'fixture', {}, 'owner');
  } else {
    let bytes: Buffer | undefined;
    const response = {
      writable: true,
      writableEnded: false,
      destroyed: false,
      write: () => true,
      end() {},
      setHeader() {},
      send(value: Buffer) {
        bytes = value;
      },
      status() {
        return this;
      },
      json(value: unknown) {
        throw new Error(JSON.stringify(value));
      },
    };
    await module.exports.exportASINData({ query: {} }, response);
    expect(Buffer.isBuffer(bytes)).toBe(true);
    output = join(directory, 'legacy-detailed.xlsx');
    await writeFile(output, bytes!);
  }
  expect(output).toBeDefined();
  return output!;
}

async function neoFile(
  directory: string,
  result: AsinGroupReadResult,
  layout?: 'task' | 'detailed',
) {
  const taskId = randomUUID(),
    createdAt = '2026-09-27T00:00:00.000Z';
  const data = {
    taskId,
    userId: 'owner',
    taskType: 'export',
    taskSubType: 'asin',
    exportType: 'asin',
    createdAt,
    params: { country: 'US', ...(layout ? { layout } : {}) },
  } as AsinExportJobData;
  let state: TaskState = {
    taskId,
    userId: 'owner',
    taskType: 'export',
    taskSubType: 'asin',
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
  const store = {
    read: async () => state,
    mutate: async (
      _id: string,
      change: Parameters<typeof transitionTask>[1],
    ) => {
      state = transitionTask(state, change, new Date());
      return state;
    },
  };
  let page = 0;
  const repository = {
    read: async (
      operation: (unit: unknown, ensureOpen: () => void) => Promise<unknown>,
    ) =>
      operation(
        {
          listExportGroups: async () =>
            ++page === 1
              ? { ...result, asins: [] }
              : {
                  groups: [],
                  asins: [],
                  total: result.total,
                  totalASINs: result.totalASINs,
                },
          listExportChildrenPage: async () => result.asins,
        },
        () => undefined,
      ),
  } as unknown as AsinExportQueryRepositoryPort;
  const artifacts = new ExportArtifactStore(directory);
  const processor = createAsinExportProcessor(
    repository,
    store as never,
    artifacts,
    {
      shutdownSignal: new AbortController().signal,
      isClosing: () => false,
      assertJobLock: async () => undefined,
      updateProgress: async () => undefined,
      now: () => new Date('2026-09-27T00:00:00.000Z'),
    },
    { info() {}, warn() {}, error() {} },
  );
  await processor(
    {
      id: taskId,
      name: 'asin',
      data,
      attemptsMade: 0,
      opts: { attempts: 2 },
    } as Job,
    'fixture-token',
  );
  expect(state.status).toBe('completed');
  const artifact = (
    state.result as { artifact: Parameters<typeof artifacts.verifiedPath>[0] }
  ).artifact;
  return artifacts.verifiedPath(artifact, new AbortController().signal);
}
async function records(filename: string) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(filename);
  const sheet = book.worksheets[0]!;
  const zip = await JSZip.loadAsync(await readFile(filename));
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const dates: Record<
    string,
    { instant: number; serial: string; numFmt: string }
  > = {};
  const rows: unknown[][] = [],
    types: number[][] = [];
  sheet.eachRow({ includeEmpty: true }, (row) => {
    rows.push(
      Array.from(
        { length: sheet.columnCount },
        (_, i) => row.getCell(i + 1).value ?? '',
      ),
    );
    types.push(
      Array.from(
        { length: sheet.columnCount },
        (_, i) => row.getCell(i + 1).type,
      ),
    );
    row.eachCell((cell) => {
      if (!(cell.value instanceof Date)) return;
      const cellXml = xml.match(
        new RegExp(`<c\\b[^>]*r="${cell.address}"[^>]*>[\\s\\S]*?</c>`),
      )![0];
      dates[cell.address] = {
        instant: cell.value.getTime(),
        serial: cellXml.match(/<v>([0-9.]+)<\/v>/)![1]!,
        numFmt: cell.numFmt,
      };
    });
  });
  return {
    rows,
    types,
    widths: sheet.columns.map((column) => column.width),
    dates,
  };
}

describe('actual Legacy XLSX records, never wall-string substitutes for MySQL Dates', () => {
  it.each([undefined, 'task', 'detailed'] as const)(
    'matches all actual Legacy rows/types/widths/Date instants and XML serials for layout %s',
    async (layout) => {
      const directory = await mkdtemp(join(tmpdir(), 'neo-legacy-asin-file-'));
      directories.push(directory);
      const f = fixture();
      expect(f.created.toISOString()).toBe('2026-09-26T16:00:00.123Z');
      const legacy = await records(
        await legacyFile(directory, f.legacy, layout ?? 'task'),
      );
      expect(legacy.rows.length).toBe(3);
      expect(legacy.rows[0]).toHaveLength(layout === 'detailed' ? 15 : 12);
      expect(Object.keys(legacy.dates)).toHaveLength(3);
      const neo = await records(await neoFile(directory, f.result, layout));
      // These assertions intentionally fail before dual-layout/Date fixes.
      // No assertion declares a detected compatibility difference a success.
      expect(neo.rows).toEqual(legacy.rows);
      expect(neo.types).toEqual(legacy.types);
      expect(neo.widths).toEqual(legacy.widths);
      expect(neo.dates).toEqual(legacy.dates);
      for (const date of Object.values(neo.dates))
        expect(date.numFmt).toBe('mm-dd-yy');
    },
  );
  it('preserves actual Date instants and full artifacts across real host timezone changes', async () => {
    const previous = process.env.TZ;
    const offsets = new Set<number>();
    const baseline = new Map<string, Awaited<ReturnType<typeof records>>>();
    try {
      for (const tz of ['UTC', 'Asia/Shanghai', 'America/New_York']) {
        process.env.TZ = tz;
        const f = fixture();
        offsets.add(f.created.getTimezoneOffset());
        expect(f.created.toISOString()).toBe('2026-09-26T16:00:00.123Z');
        for (const layout of ['task', 'detailed'] as const) {
          const directory = await mkdtemp(
            join(tmpdir(), 'neo-legacy-asin-tz-'),
          );
          directories.push(directory);
          const legacy = await records(
            await legacyFile(directory, f.legacy, layout),
          );
          if (baseline.has(layout))
            expect(legacy).toEqual(baseline.get(layout));
          else baseline.set(layout, legacy);
          expect(
            await records(await neoFile(directory, f.result, layout)),
          ).toEqual(legacy);
        }
      }
      expect(offsets.size).toBe(3);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});
