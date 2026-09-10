import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import utc from 'dayjs/plugin/utc';
import ExcelJS from 'exceljs';
import { parse } from 'fast-csv';
import iconv from 'iconv-lite';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  IMPORT_MAX_CELL_LENGTH,
  IMPORT_MAX_COLUMNS,
  IMPORT_MAX_DATA_ROWS,
  ImportParseError,
  ImportPlanBuilder,
  type ImportPlan,
} from './rows';

dayjs.extend(customParseFormat);
dayjs.extend(utc);

export const IMPORT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const IMPORT_PARSE_TIMEOUT_MS = 120_000;
const MAX_SHEET_ROWS = 1_048_576;
const dateFormats = [
  'YYYY-MM-DD[T]HH:mm:ssZ',
  'YYYY-MM-DD[T]HH:mm:ss',
  'MM-DD-YYYY',
  'YYYY-MM-DD',
];
const specialValues: Record<string, ExcelJS.CellValue> = {
  true: true,
  false: false,
  '#N/A': { error: '#N/A' },
  '#REF!': { error: '#REF!' },
  '#NAME?': { error: '#NAME?' },
  '#DIV/0!': { error: '#DIV/0!' },
  '#NULL!': { error: '#NULL!' },
  '#VALUE!': { error: '#VALUE!' },
  '#NUM!': { error: '#NUM!' },
};

// ExcelJS's default CSV map is part of the existing import behavior: numeric
// text loses leading zeroes, and dates/booleans/errors become typed cell values.
function csvValue(value: string): ExcelJS.CellValue {
  if (value === '') return null;
  const number = Number(value);
  if (!Number.isNaN(number) && number !== Infinity) return number;
  if (/^(?:\d{2}|\d{4})-/.test(value)) {
    for (const format of dateFormats) {
      const date = dayjs(value, format, true);
      if (date.isValid()) return new Date(date.valueOf());
    }
  }
  return specialValues[value] !== undefined ? specialValues[value] : value;
}

async function csvEncoding(path: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const file = await open(path, 'r');
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > IMPORT_MAX_FILE_BYTES)
      throw new ImportParseError('capacity', '导入文件超过 10 MiB 限制');
    const preview = Buffer.alloc(4096);
    const { bytesRead } = await file.read(preview, 0, preview.length, 0);
    signal.throwIfAborted();
    const bytes = preview.subarray(0, bytesRead);
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
      return { encoding: 'utf8', start: 3 };
    if (bytes[0] === 0xff && bytes[1] === 0xfe)
      return { encoding: 'utf16-le', start: 2 };
    if (bytes[0] === 0xfe && bytes[1] === 0xff)
      return { encoding: 'utf16-be', start: 2 };
    const replacements = (text: string) => (text.match(/\uFFFD/g) || []).length;
    const utf8Count = replacements(bytes.toString('utf8'));
    if (utf8Count) {
      const decoded = iconv.decode(bytes, 'gb18030');
      if (replacements(decoded) < utf8Count && /[\u4e00-\u9fff]/.test(decoded))
        return { encoding: 'gb18030', start: 0 };
    }
    return { encoding: 'utf8', start: 0 };
  } finally {
    await file.close();
  }
}

/** Each pass retains only one ExcelJS row. The first discovers the actual
 * worksheet width, which the Legacy header fallback depends on. */
async function scanCsv(
  path: string,
  encoding: { encoding: string; start: number },
  signal: AbortSignal,
  onRow: (rowNumber: number, cells: string[]) => void,
) {
  signal.throwIfAborted();
  const input = createReadStream(path, { start: encoding.start, signal });
  let size = encoding.start;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      callback(
        size > IMPORT_MAX_FILE_BYTES
          ? new ImportParseError('capacity', '导入文件超过 10 MiB 限制')
          : null,
        chunk,
      );
    },
  });
  const decoder = iconv.decodeStream(encoding.encoding) as Transform;
  const parser = parse();
  let pipelineError: unknown;
  // Attach rejection handling immediately; the parser iterator surfaces stream
  // errors and finally always waits for descriptor/decoder teardown.
  const completion = pipeline(input, limit, decoder, parser, { signal }).catch(
    (error: unknown) => {
      pipelineError = error;
    },
  );
  const sheet = new ExcelJS.Workbook().addWorksheet('Import');
  let rowNumber = 0;
  let dataRows = 0;
  try {
    for await (const raw of parser) {
      signal.throwIfAborted();
      const values = raw as string[];
      if (++rowNumber > MAX_SHEET_ROWS)
        throw new ImportParseError('capacity', '导入文件行数超过限制');
      if (values.length > IMPORT_MAX_COLUMNS)
        throw new ImportParseError('capacity', '导入文件列数超过限制');
      if (values.some((value) => value.length > IMPORT_MAX_CELL_LENGTH))
        throw new ImportParseError('capacity', '导入文件单元格超过限制');
      const row = sheet.addRow(values.map(csvValue));
      const cells = Array.from(
        { length: row.cellCount },
        (_, index) => row.getCell(index + 1).text ?? '',
      );
      if (
        rowNumber > 1 &&
        cells.some((cell) => cell.trim() !== '') &&
        ++dataRows > IMPORT_MAX_DATA_ROWS
      )
        throw new ImportParseError('capacity', '导入文件数据行超过限制');
      onRow(rowNumber, cells);
      sheet.spliceRows(1, 1);
    }
    await completion;
    if (pipelineError) throw pipelineError;
    return rowNumber;
  } finally {
    input.destroy();
    limit.destroy();
    decoder.destroy();
    parser.destroy();
    await completion;
  }
}

export async function parseCsvFile(
  path: string,
  options: { signal?: AbortSignal } = {},
): Promise<ImportPlan> {
  const timeout = AbortSignal.timeout(IMPORT_PARSE_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  try {
    const encoding = await csvEncoding(path, signal);
    let headers: string[] = [];
    let maxColumns = 0;
    const totalRows = await scanCsv(path, encoding, signal, (number, cells) => {
      if (number === 1) headers = cells;
      maxColumns = Math.max(maxColumns, cells.length);
    });
    if (totalRows < 2)
      throw new ImportParseError(
        'invalid',
        'Excel文件至少需要包含表头和数据行',
      );
    const builder = new ImportPlanBuilder(headers, maxColumns);
    await scanCsv(path, encoding, signal, (number, cells) => {
      if (number > 1) builder.add(number, cells);
    });
    return builder.finish(totalRows);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ImportParseError) throw error;
    throw new ImportParseError('invalid', 'CSV文件无法解析');
  }
}
