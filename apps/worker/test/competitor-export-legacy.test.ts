import {
  transitionTask,
  type CatalogExportQueryRepositoryPort,
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
import { describe, expect, it, vi } from 'vitest';
import { createAsinExportProcessor } from '../src/asin-export-processor';
import { createVariantGroupExportProcessor } from '../src/variant-group-export-processor';

const root = resolve(__dirname, '../../..');
const requireLegacy = createRequire(join(root, 'server/package.json'));
const at = new Date('2026-09-26T16:00:00.123Z');
const manual = {
  site: '',
  manualBroken: false,
  manualBrokenReason: null,
  manualBrokenUpdatedAt: null,
  manualBrokenUpdatedBy: null,
};
const group = {
  ...manual,
  id: ' Raw-É ',
  name: '=literal group',
  country: 'US',
  brand: '品牌',
  isBroken: true,
  createTime: at,
  updateTime: at,
  lastCheckTime: at,
  exportCursorTime: '2026-09-27 00:00:00.123000',
  exportIsBroken: true,
  exportHasAutoBroken: true,
  exportHasManualBroken: false,
};
const empty = {
  ...group,
  id: 'empty',
  name: 'empty persisted broken',
  isBroken: true,
  exportIsBroken: false,
  exportHasAutoBroken: false,
  updateTime: null,
  lastCheckTime: null,
};
const child = {
  ...manual,
  id: 'child',
  variantGroupId: group.id,
  asin: 'B000000001',
  name: 'Child',
  asinType: '1',
  country: 'US',
  brand: '品牌',
  isBroken: true,
  createTime: at,
  updateTime: at,
  lastCheckTime: at,
  exportCursorTime: '2026-09-27 00:00:00.123000',
  manualExcludedFromGroup: false,
  manualExcludedReason: null,
  manualExcludedUpdatedAt: null,
  manualExcludedUpdatedBy: null,
};

async function legacy(
  directory: string,
  kind: 'asin' | 'variant-group',
  direct: boolean,
) {
  const relative = direct
    ? 'server/src/controllers/exportController.js'
    : 'server/src/services/exportTaskProcessor.js';
  const sourcePath = join(root, relative),
    source = await readFile(sourcePath, 'utf8');
  const name = direct
    ? kind === 'asin'
      ? 'exportCompetitorASINData'
      : 'exportCompetitorVariantGroupData'
    : kind === 'asin'
    ? 'processCompetitorASINExport'
    : 'processCompetitorVariantGroupExport';
  const module = {
    exports: {} as Record<string, (...args: unknown[]) => Promise<unknown>>,
  };
  let output: string | undefined;
  const requireStub = (specifier: string): unknown => {
    if (specifier === 'exceljs') return ExcelJS;
    if (specifier === 'fs')
      return {
        promises: {
          mkdir: async () => undefined,
          writeFile: async (path: string, bytes: Buffer) => {
            output = join(directory, `legacy-${basename(path)}`);
            await writeFile(output, bytes);
          },
        },
      };
    if (specifier === 'path' || specifier === 'worker_threads')
      return requireLegacy(specifier);
    if (specifier.endsWith('/models/CompetitorVariantGroup'))
      return {
        findAll: async () => ({
          list: [
            { ...group, isBroken: 1, children: [{ ...child, isBroken: 1 }] },
            { ...empty, isBroken: 0, children: [] },
          ],
          total: 2,
        }),
      };
    if (specifier.endsWith('/dateTime'))
      return { getUTC8String: () => '2026-09-27' };
    if (specifier.endsWith('/logger'))
      return { debug() {}, info() {}, warn() {}, error() {} };
    if (specifier.endsWith('taskCancellationService'))
      return {
        throwIfTaskCancelled: async () => undefined,
        isTaskCancelledError: () => false,
      };
    if (specifier.endsWith('taskRegistryService'))
      return { updateTaskProgress: async () => undefined };
    if (specifier.endsWith('websocketService'))
      return { sendTaskProgress() {} };
    return {};
  };
  const execute = vm.runInThisContext(
    `(function(require,module,exports,__dirname,process){\n${source}\nmodule.exports.__oracle=${name};\n})`,
    { filename: sourcePath },
  );
  execute(requireStub, module, module.exports, dirname(sourcePath), {
    env: { EXPORT_WORKER_ENABLED: 'false' },
  });
  if (direct) {
    const response = {
      writable: true,
      headersSent: false,
      setHeader() {},
      write() {},
      send(bytes: Buffer) {
        output = join(directory, `legacy-direct-${kind}.xlsx`);
        return writeFile(output, bytes);
      },
      status() {
        throw new Error('Legacy exporter failed');
      },
    };
    await module.exports.__oracle!({ query: {} }, response);
    // Express send is sync; wait for the fixture's actual async write.
    await vi.waitFor(async () =>
      expect(await readFile(output!)).toBeInstanceOf(Buffer),
    );
  } else
    await module.exports.__oracle!(
      { progress() {} },
      'legacy-fixture',
      {},
      'owner',
    );
  if (!output) throw new Error('Legacy did not publish XLSX');
  return output;
}
async function records(path: string) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(path);
  const sheet = workbook.worksheets[0]!,
    rows: unknown[][] = [],
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
  });
  return {
    name: sheet.name,
    rows,
    types,
    widths: sheet.columns.map((column) => column.width),
  };
}
describe('competitor workbooks against both unchanged Legacy exporters', () => {
  it.each(['asin', 'variant-group'] as const)(
    'matches every %s row, Date instant, type, header and width',
    async (kind) => {
      const directory = await mkdtemp(join(tmpdir(), 'neo-competitor-export-'));
      try {
        const taskId = randomUUID(),
          exportType = `competitor-${kind}` as const;
        const data = {
          taskId,
          taskType: 'export',
          taskSubType: exportType,
          exportType,
          userId: 'owner',
          createdAt: at.toISOString(),
          params: {},
        };
        let state = {
          ...data,
          title: exportType,
          status: 'pending',
          progress: 0,
          message: '',
          error: null,
          result: null,
          updatedAt: data.createdAt,
          startedAt: null,
          completedAt: null,
          cancelRequestedAt: null,
          cancelledAt: null,
          revision: 0,
        } as TaskState;
        const repository: CatalogExportQueryRepositoryPort = {
          read: async (action) => {
            let page = 0;
            return action(
              {
                listExportGroups: async () =>
                  ({
                    groups: ++page === 1 ? [group, empty] : [],
                    asins: [],
                    total: 2,
                    totalASINs: 1,
                  } as never),
                listExportChildrenPage: async () => [child] as never,
              },
              () => undefined,
            );
          },
        };
        const store = {
          read: async () => state,
          mutate: async (
            _id: string,
            change: Parameters<typeof transitionTask>[1],
          ) => (state = transitionTask(state, change, new Date())),
        };
        const artifacts = new ExportArtifactStore(directory),
          options = {
            competitor: true,
            shutdownSignal: new AbortController().signal,
            isClosing: () => false,
            assertJobLock: async () => undefined,
            updateProgress: async () => undefined,
            now: () => at,
          };
        const processor =
          kind === 'asin'
            ? createAsinExportProcessor(repository, store, artifacts, options)
            : createVariantGroupExportProcessor(
                repository,
                store,
                artifacts,
                options,
              );
        await processor(
          {
            id: taskId,
            name: exportType,
            data,
            attemptsMade: 0,
            opts: { attempts: 2 },
          } as never,
          'fixture',
        );
        const neo = await records(join(directory, `export-${taskId}.xlsx`));
        expect(state).toMatchObject({
          status: 'completed',
          result: { exportType },
        });
        expect(neo.rows).toHaveLength(3);
        for (const direct of [false, true])
          expect(neo).toEqual(
            await records(await legacy(directory, kind, direct)),
          );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
