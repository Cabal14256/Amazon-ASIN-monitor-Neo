import type { ParentAsinQueryItem } from '@asin-monitor/contracts';
import ExcelJS from 'exceljs';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { parentExportFixture } from './helpers/parent-asin-export-fixture';

const root = resolve(__dirname, '../../..');
const legacyRequire = createRequire(join(root, 'server/package.json'));
async function oracle(
  directory: string,
  rows: readonly ParentAsinQueryItem[],
  direct: boolean,
) {
  const sourcePath = join(
    root,
    direct
      ? 'server/src/controllers/exportController.js'
      : 'server/src/services/exportTaskProcessor.js',
  );
  const source = await readFile(sourcePath, 'utf8');
  const module = {
    exports: {} as Record<string, (...args: unknown[]) => Promise<unknown>>,
  };
  let output: string | undefined;
  const batchQueryParentAsin = vi.fn(async () => rows);
  const requireStub = (name: string): unknown => {
    if (name === 'exceljs') return ExcelJS;
    if (name === 'path' || name === 'worker_threads')
      return legacyRequire(name);
    if (name === 'fs')
      return {
        promises: {
          mkdir: async () => undefined,
          writeFile: async (file: string, bytes: Buffer) => {
            output = join(directory, 'legacy-' + basename(file));
            await writeFile(output, bytes);
          },
        },
      };
    if (name.endsWith('/dateTime'))
      return {
        getUTC8String: (format: string) =>
          format === 'YYYY-MM-DD' ? '2026-09-27' : '2026-09-27 00:01:02',
      };
    if (name.endsWith('/logger'))
      return { debug() {}, info() {}, warn() {}, error() {} };
    if (name.endsWith('variantCheckService')) return { batchQueryParentAsin };
    if (name.endsWith('taskCancellationService'))
      return {
        throwIfTaskCancelled: async () => undefined,
        isTaskCancelledError: () => false,
      };
    if (name.endsWith('taskRegistryService'))
      return { updateTaskProgress: async () => undefined };
    if (name.endsWith('websocketService')) return { sendTaskProgress() {} };
    return {};
  };
  const name = direct
    ? 'exportParentAsinQuery'
    : 'processParentAsinQueryExport';
  vm.runInThisContext(
    `(function(require,module,exports,__dirname,process){\n${source}\nmodule.exports.__oracle=${name};\n})`,
    { filename: sourcePath },
  )(requireStub, module, module.exports, dirname(sourcePath), {
    env: { EXPORT_WORKER_ENABLED: 'false' },
  });
  const params = {
    asins: 'b000000001, B000000004\nB000000002,B000000001',
    country: 'US',
  };
  if (direct) {
    await module.exports.__oracle!(
      { query: params },
      {
        writable: true,
        headersSent: false,
        setHeader() {},
        write() {
          return true;
        },
        send(bytes: Buffer) {
          output = join(directory, 'legacy-direct.xlsx');
          return writeFile(output, bytes);
        },
        status() {
          throw new Error('Legacy export failed');
        },
      },
    );
    await vi.waitFor(async () =>
      expect(await readFile(output!)).toBeInstanceOf(Buffer),
    );
  } else
    await module.exports.__oracle!(
      { progress() {} },
      'legacy-parent',
      params,
      'owner',
    );
  expect(batchQueryParentAsin).toHaveBeenCalledWith(
    ['B000000001', 'B000000004', 'B000000002', 'B000000001'],
    'US',
  );
  if (!output) throw new Error('Missing Legacy workbook');
  return records(output);
}
async function records(file: string) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(file);
  const sheet = workbook.worksheets[0]!;
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
  });
  return {
    name: sheet.name,
    rows,
    types,
    widths: sheet.columns.map((column) => column.width),
  };
}
describe('parent export complete unchanged Legacy workbook oracles', () => {
  it('matches all eleven columns, flags, error rows, query timestamps, duplicates, types and widths', async () => {
    const f = await parentExportFixture();
    try {
      await f.processor(f.job as never, 'lock');
      expect(f.state).toMatchObject({
        status: 'completed',
        result: { filename: 'ASIN父变体查询结果_2026-09-27.xlsx', rowCount: 4 },
      });
      expect(f.query).toHaveBeenCalledTimes(1);
      const neo = await records(join(f.directory, `export-${f.taskId}.xlsx`));
      expect(neo.rows).toHaveLength(5);
      expect(neo.rows[1]?.[2]).toBe('是');
      expect(neo.rows[2]?.[2]).toBe('否');
      expect(neo.rows[3]?.[10]).toBe('ASIN查询失败，请稍后重试');
      expect(neo.rows[1]?.[5]).toBe('=literal B000000001');
      expect(neo.rows[1]?.[9]).toBe('2026-09-27 00:01:02');
      expect(neo.rows[4]).toEqual(neo.rows[1]);
      for (const direct of [false, true])
        expect(neo).toEqual(await oracle(f.directory, f.returned, direct));
      expect(JSON.stringify(neo)).not.toContain('private upstream detail');
    } finally {
      await f.close();
    }
  });
});
