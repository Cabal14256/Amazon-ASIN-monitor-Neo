import type { VariantGroupExportJobData } from '@asin-monitor/contracts';
import {
  transitionTask,
  type AsinExportQueryUnit,
  type TaskState,
} from '@asin-monitor/db';
import { ExportArtifactStore } from '@asin-monitor/export';
import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { createVariantGroupExportProcessor } from '../src/variant-group-export-processor';

const repo = resolve(__dirname, '../../..');
const legacyRequire = createRequire(join(repo, 'server/package.json'));
const excelRequire = createRequire(
  legacyRequire.resolve('exceljs/package.json'),
);
const JSZip = excelRequire('jszip') as {
  loadAsync(bytes: Buffer): Promise<{
    file(name: string): { async(type: 'string'): Promise<string> };
  }>;
};
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const group = {
  id: 'group-raw',
  name: 'Manual group',
  country: 'US',
  site: 'amazon.com',
  brand: 'Fixture',
  isBroken: true,
  manualBroken: true,
  manualBrokenReason: 'group reason',
  manualBrokenUpdatedAt: null,
  manualBrokenUpdatedBy: null,
  createTime: new Date('2026-09-27T00:00:00.123Z'),
  updateTime: new Date('2026-09-28T01:02:03.456Z'),
  lastCheckTime: new Date('2026-09-29T04:05:06.000Z'),
  feishuNotifyEnabled: true,
  exportIsBroken: true,
  exportHasAutoBroken: false,
  exportHasManualBroken: true,
  exportCursorTime: '2026-09-27 00:00:00.123',
};
const emptyGroup = {
  ...group,
  id: 'empty-group',
  name: 'Empty group',
  isBroken: false,
  manualBroken: false,
  manualBrokenReason: null,
  updateTime: null,
  lastCheckTime: null,
  exportIsBroken: false,
  exportHasAutoBroken: false,
  exportHasManualBroken: false,
  exportCursorTime: '2026-09-26 00:00:00.000',
};
const children = [
  {
    id: 'child-one',
    asin: 'B000000001',
    name: 'Child',
    asinType: '1',
    variantGroupId: 'group-raw',
    country: 'US',
    site: 'amazon.com',
    brand: 'Fixture',
    isBroken: false,
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
    exportCursorTime: '2026-09-26 16:00:00.000',
  },
];

async function legacyFile(directory: string) {
  const sourcePath = join(repo, 'server/src/services/exportTaskProcessor.js');
  const source = await readFile(sourcePath, 'utf8');
  const module = {
    exports: {} as Record<string, (...args: never[]) => Promise<unknown>>,
  };
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
    if (specifier.endsWith('/models/VariantGroup'))
      return {
        findAll: async () => ({
          list: [
            {
              ...group,
              isBroken: 1,
              children: [
                {
                  ...children[0],
                  isBroken: 1,
                },
              ],
            },
            { ...emptyGroup, isBroken: 0, children: [] },
          ],
          total: 2,
        }),
      };
    if (specifier.endsWith('/dateTime'))
      return { getUTC8String: () => '2026-09-27' };
    if (specifier.endsWith('/logger'))
      return { debug() {}, info() {}, warn() {}, error() {} };
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
  const execute = vm.runInThisContext(
    `(function(require,module,exports,__dirname,process){\n${source}\nmodule.exports.__oracle = processVariantGroupExport;\n})`,
    { filename: sourcePath },
  ) as (...args: unknown[]) => void;
  execute(requireStub, module, module.exports, dirname(sourcePath), {
    env: { EXPORT_WORKER_ENABLED: 'false' },
  });
  await module.exports.__oracle!(
    { progress() {} },
    'legacy-fixture',
    {},
    'owner',
  );
  if (!output) throw new Error('Legacy variant-group workbook was not written');
  return output;
}

async function neoFile(directory: string) {
  const taskId = randomUUID();
  const createdAt = '2026-09-27T00:00:00.000Z';
  const data: VariantGroupExportJobData = {
    taskId,
    userId: 'owner',
    taskType: 'export',
    taskSubType: 'variant-group',
    exportType: 'variant-group',
    createdAt,
    params: {},
  };
  let state: TaskState = {
    taskId,
    userId: 'owner',
    taskType: 'export',
    taskSubType: 'variant-group',
    title: '变体组导出',
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
  const repository = {
    read: async <T>(
      run: (unit: AsinExportQueryUnit, ensureOpen: () => void) => Promise<T>,
    ) => {
      let page = 0;
      return run(
        {
          listExportGroups: async () =>
            ++page === 1
              ? {
                  groups: [group, emptyGroup],
                  asins: [],
                  total: 2,
                  totalASINs: 1,
                }
              : { groups: [], asins: [], total: 2, totalASINs: 1 },
          listExportChildrenPage: async () => children,
        } as unknown as AsinExportQueryUnit,
        () => undefined,
      );
    },
  };
  const store = {
    read: async () => state,
    mutate: async (
      _id: string,
      change: Parameters<typeof transitionTask>[1],
    ) => {
      state = transitionTask(
        state,
        change,
        new Date('2026-09-27T00:30:00.000Z'),
      );
      return state;
    },
  };
  const artifacts = new ExportArtifactStore(directory);
  await createVariantGroupExportProcessor(
    repository as never,
    store as never,
    artifacts,
    {
      shutdownSignal: new AbortController().signal,
      isClosing: () => false,
      assertJobLock: async () => undefined,
      updateProgress: async () => undefined,
      now: () => new Date('2026-09-27T16:01:00.000Z'),
    },
    { info() {}, warn() {}, error() {} },
  )(
    {
      id: taskId,
      name: 'variant-group',
      data,
      attemptsMade: 0,
      opts: { attempts: 2 },
    } as never,
    'fixture-lock',
  );
  return join(directory, `export-${taskId}.xlsx`);
}

async function records(filename: string) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filename);
  const sheet = workbook.worksheets[0]!;
  const zip = await JSZip.loadAsync(await readFile(filename));
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  const rows: unknown[][] = [];
  const types: number[][] = [];
  const dates: Record<
    string,
    { instant: number; serial: string; numFmt: string }
  > = {};
  sheet.eachRow({ includeEmpty: true }, (row) => {
    rows.push(
      Array.from(
        { length: sheet.columnCount },
        (_, index) => row.getCell(index + 1).value ?? '',
      ),
    );
    types.push(
      Array.from(
        { length: sheet.columnCount },
        (_, index) => row.getCell(index + 1).type,
      ),
    );
    row.eachCell((cell) => {
      if (!(cell.value instanceof Date)) return;
      const cellXml = xml.match(
        new RegExp(`<c\\b[^>]*r="${cell.address}"[^>]*>[\\s\\S]*?</c>`),
      )![0]!;
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

describe('actual Legacy async variant-group workbook parity', () => {
  it('matches the real Legacy task processor rows, cell types, widths and date serials', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'neo-variant-group-legacy-'),
    );
    directories.push(directory);
    const legacy = await records(await legacyFile(directory));
    const neo = await records(await neoFile(directory));
    expect(legacy.rows).toHaveLength(3);
    expect(legacy.rows[0]).toHaveLength(11);
    expect(neo).toEqual(legacy);
  });
});
