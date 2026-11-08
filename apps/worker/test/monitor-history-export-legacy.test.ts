import type { MonitorHistoryExportRow } from '@asin-monitor/db';
import ExcelJS from 'exceljs';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { monitorHistoryExportRow } from '../src/monitor-history-export-rows';
import { historyExportFixture } from './helpers/monitor-history-export-fixture';

const root = path.resolve(__dirname, '../../..'),
  nativeRequire = createRequire(path.join(root, 'server/package.json'));
async function records(file: string) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.readFile(file);
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
    font: sheet.getCell('A1').font,
    fill: sheet.getCell('A1').fill,
  };
}
async function legacy(
  directory: string,
  sourceRows: readonly MonitorHistoryExportRow[],
  direct: boolean,
) {
  const sourcePath = path.join(
    root,
    direct
      ? 'server/src/controllers/exportController.js'
      : 'server/src/services/exportTaskProcessor.js',
  );
  const source = await fs.readFile(sourcePath, 'utf8'),
    module = {
      exports: {} as Record<string, (...args: unknown[]) => Promise<unknown>>,
    };
  const list = sourceRows.map(({ record }) => {
    // Legacy init.sql declares check_result as TEXT, so mysql2 preserves its
    // text. Parsing at this fixture boundary would conceal a double-decode bug.
    const decoded = record.checkResult;
    return {
      ...record,
      check_time: record.checkTime,
      check_result: decoded,
      checkResult: decoded,
    };
  });
  const findAll = vi.fn(async () => ({ list, total: list.length }));
  let output: string | undefined;
  const requireStub = (name: string): unknown => {
    if (name === 'exceljs') return ExcelJS;
    if (name === 'fs') return { promises: fs };
    if (name === 'path')
      return {
        ...path,
        join: (...parts: string[]) =>
          parts[1] === '../../tasks/export' ? directory : path.join(...parts),
      };
    if (name === 'worker_threads') return nativeRequire(name);
    if (name.endsWith('/models/MonitorHistory')) return { findAll };
    if (name.endsWith('/dateTime'))
      return {
        getUTC8String: (format: string) =>
          format === 'YYYY-MM-DD' ? '2026-09-27' : '2026-09-27 00:01:02',
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
  const name = direct ? 'exportMonitorHistory' : 'processMonitorHistoryExport';
  vm.runInThisContext(
    `(function(require,module,exports,__dirname,process){\n${source}\nmodule.exports.__oracle=${name};\n})`,
    { filename: sourcePath },
  )(requireStub, module, module.exports, path.dirname(sourcePath), {
    env: { EXPORT_WORKER_ENABLED: 'false' },
  });
  const params = {
    country: 'US',
    startTime: '2026-09-01',
    endTime: '2026-10-01',
  };
  if (direct) {
    const response = Object.assign(new PassThrough(), {
      headersSent: false,
      setHeader() {},
      status() {
        throw new Error('Legacy history export failed');
      },
    });
    const chunks: Buffer[] = [];
    response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    const closed = finished(response);
    try {
      await module.exports.__oracle!({ query: params }, response);
      expect(response.writableEnded).toBe(true);
      await closed;
      output = path.join(directory, 'legacy-direct.xlsx');
      await fs.writeFile(output, Buffer.concat(chunks));
    } catch (error) {
      response.destroy();
      await closed.catch(() => undefined);
      throw error;
    }
  } else {
    await module.exports.__oracle!(
      { progress() {} },
      'legacy-history',
      params,
      'owner',
    );
    output = path.join(directory, 'legacy-history.xlsx');
  }
  expect(findAll).toHaveBeenCalledWith(
    expect.objectContaining({
      ...params,
      skipCount: true,
      current: 1,
      pageSize: 10000,
    }),
  );
  if (!output) throw new Error('Missing Legacy history workbook');
  return records(output);
}
describe('monitor history XLSX versus both unchanged Legacy exporters', () => {
  it('preserves Legacy TEXT decoding for JSON scalars and nested-string payloads', async () => {
    const f = await historyExportFixture();
    try {
      const source = f.rows[0]!;
      const values = [
        null,
        false,
        0,
        '',
        'literal text',
        JSON.stringify({
          source: 'MANUAL_ACTION',
          action: 'MARK_BROKEN',
          reason: 'Nested reason',
        }),
      ];
      f.setRows(
        values.map((value, index) => ({
          cursor: { ...source.cursor, id: String(values.length - index) },
          record: { ...source.record, checkResult: JSON.stringify(value) },
        })),
      );
      await f.processor(f.job as never, 'lock');
      const actual = await records(
        path.join(f.directory, `export-${f.taskId}.xlsx`),
      );
      expect(actual.rows.slice(1).map((row) => row[12])).toEqual(
        values.map((value) => JSON.stringify(value, null, 2)),
      );
      // A JSON string containing object text remains a string after the one
      // Legacy parse; it cannot supply artificial manual-action metadata.
      expect(actual.rows.at(-1)?.slice(8, 12)).toEqual(['', '', '', '']);
      for (const direct of [false, true])
        expect(actual).toEqual(await legacy(f.directory, f.rows, direct));
    } finally {
      await f.close();
    }
  });
  it('matches complete thirteen-column rows, manual fields, nulls, types, widths and header style', async () => {
    const f = await historyExportFixture();
    try {
      await f.processor(f.job as never, 'lock');
      expect(f.state).toMatchObject({
        status: 'completed',
        result: {
          exportType: 'monitor-history',
          filename: '监控历史_2026-09-27.xlsx',
          rowCount: 4,
        },
      });
      const actual = await records(
        path.join(f.directory, `export-${f.taskId}.xlsx`),
      );
      expect(actual.rows).toHaveLength(5);
      expect(actual.rows[0]).toHaveLength(13);
      expect(actual.rows[1]?.[9]).toBe('人工标记异常');
      expect(actual.rows[2]?.[5]).toBe('副评');
      expect(actual.rows[2]?.[11]).toBe(7);
      expect(actual.rows[2]?.[8]).toBe(true);
      for (const direct of [false, true])
        expect(actual).toEqual(await legacy(f.directory, f.rows, direct));
    } finally {
      await f.close();
    }
  });
  it('keeps structured historical metadata as literal text instead of formula/hyperlink cell definitions', () => {
    const record = {
      checkTime: '2026-09-27 00:00:00',
      checkType: 'GROUP',
      variantGroupName: 'Group',
      asin: null,
      asinName: null,
      asinType: null,
      country: 'US',
      isBroken: 0 as const,
      checkResult: JSON.stringify({
        reason: { formula: 'HYPERLINK("https://invalid")' },
        operator: { text: 'click', hyperlink: 'https://invalid' },
      }),
    };
    const row = monitorHistoryExportRow(record);
    expect(row[10]).toBe('{"formula":"HYPERLINK(\\"https://invalid\\")"}');
    expect(typeof row[11]).toBe('string');
  });
});
