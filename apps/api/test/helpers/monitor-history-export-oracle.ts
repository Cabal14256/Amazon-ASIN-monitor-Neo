import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import vm from 'node:vm';

export interface HistoryWorkbook {
  name: string;
  rows: unknown[][];
  types: number[][];
  widths: (number | undefined)[];
}
interface ExcelBook {
  xlsx: {
    readFile(path: string): Promise<unknown>;
    load(bytes: Buffer): Promise<unknown>;
  };
  worksheets: {
    name: string;
    columnCount: number;
    columns: { width?: number }[];
    eachRow(
      options: { includeEmpty: boolean },
      action: (row: {
        getCell(index: number): { value: unknown; type: number };
      }) => void,
    ): void;
  }[];
}
const nativeRequire = createRequire(__filename);
// Resolve ExcelJS through its owning workspace, without adding an API runtime dependency.
const Excel = createRequire(join(__dirname, '../../../worker/package.json'))(
  'exceljs',
) as { Workbook: new () => ExcelBook };
export async function historyWorkbook(
  bytes: Buffer | string,
): Promise<HistoryWorkbook> {
  const book = new Excel.Workbook();
  if (typeof bytes === 'string') await book.xlsx.readFile(bytes);
  else await book.xlsx.load(bytes);
  const sheet = book.worksheets[0]!,
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
export function canonicalHistoryWorkbook(book: HistoryWorkbook) {
  return {
    ...book,
    rows: book.rows.map((row, index) =>
      row.map((cell, column) => {
        if (index && column === 12 && typeof cell === 'string' && cell) {
          try {
            return JSON.parse(cell);
          } catch {
            return cell;
          }
        }
        return cell;
      }),
    ),
  };
}
/** Execute the unchanged Legacy task exporter and its real MySQL model. Only
 * filesystem destination, time naming, progress and task control are fixture seams. */
export async function legacyHistoryWorkbook(
  directory: string,
  model: unknown,
  params: Record<string, unknown>,
) {
  const root = resolve(__dirname, '../../../..'),
    sourcePath = join(root, 'server/src/services/exportTaskProcessor.js');
  const source = await readFile(sourcePath, 'utf8'),
    module = {
      exports: {} as Record<string, (...args: unknown[]) => Promise<unknown>>,
    };
  const native = nativeRequire;
  const load = (name: string): unknown => {
    if (name === 'exceljs') return Excel;
    if (name === 'fs') return { promises: { mkdir: async () => undefined } };
    if (name === 'path')
      return {
        ...native('node:path'),
        join: (...parts: string[]) =>
          parts[1] === '../../tasks/export' ? directory : join(...parts),
      };
    if (name === 'worker_threads') return native(name);
    if (name.endsWith('/models/MonitorHistory')) return model;
    if (name.endsWith('/dateTime'))
      return {
        getUTC8String: (format: string) =>
          format === 'YYYY-MM-DD' ? '2026-09-27' : '2026-09-27 00:00:00',
      };
    if (name.endsWith('/logger'))
      return { debug() {}, info() {}, warn() {}, error() {} };
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
  vm.runInThisContext(
    `(function(require,module,exports,__dirname,process){\n${source}\nmodule.exports.__oracle=processMonitorHistoryExport;\n})`,
    { filename: sourcePath },
  )(load, module, module.exports, dirname(sourcePath), {
    env: { EXPORT_WORKER_ENABLED: 'false' },
  });
  await module.exports.__oracle!(
    { progress() {} },
    'legacy-history-real',
    params,
    'fixture-owner',
  );
  return historyWorkbook(join(directory, basename('legacy-history-real.xlsx')));
}
