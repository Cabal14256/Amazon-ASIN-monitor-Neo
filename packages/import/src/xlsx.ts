import ExcelJS from 'exceljs';
import { stat } from 'node:fs/promises';
import { posix } from 'node:path';
import { openPromise, type Entry, type ZipFile } from 'yauzl';
import { IMPORT_MAX_FILE_BYTES, IMPORT_PARSE_TIMEOUT_MS } from './csv';
import {
  IMPORT_MAX_CELL_LENGTH,
  IMPORT_MAX_COLUMNS,
  IMPORT_MAX_DATA_ROWS,
  IMPORT_MAX_TEXT_CHARS,
  ImportParseError,
  ImportPlanBuilder,
  type ImportPlan,
} from './rows';
import {
  cellAddress,
  IMPORT_MAX_SHEET_ROWS,
  ImportMerges,
} from './xlsx-merges';
import {
  ExcelRow,
  readXml,
  RelationshipsXform,
  RowXform,
  SharedStringsXform,
  StylesXform,
  WorkbookXform,
} from './xlsx-xml';

const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_SHEET_BYTES = 64 * 1024 * 1024;
const MAX_SHARED_STRINGS_BYTES = 32 * 1024 * 1024;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;

async function archiveEntries(zip: ZipFile, signal: AbortSignal) {
  if (zip.entryCount > 1000)
    throw new ImportParseError('capacity', 'XLSX ZIP 条目超过限制');
  const entries = new Map<string, Entry>();
  let totalBytes = 0;
  for await (const entry of zip.eachEntry()) {
    signal.throwIfAborted();
    totalBytes += entry.uncompressedSize;
    if (
      totalBytes > MAX_ARCHIVE_BYTES ||
      entry.uncompressedSize > MAX_SHEET_BYTES
    )
      throw new ImportParseError('capacity', 'XLSX 解压内容超过限制');
    if (entries.has(entry.fileName))
      throw new ImportParseError('invalid', 'XLSX ZIP 条目重复');
    if (!entry.canDecodeFileData())
      throw new ImportParseError('invalid', 'XLSX ZIP 加密或压缩格式不受支持');
    entries.set(entry.fileName, entry);
  }
  return entries;
}

function relatedPath(base: string, target: string) {
  const resolved = posix.normalize(
    target.startsWith('/')
      ? target.slice(1)
      : posix.join(posix.dirname(base), target),
  );
  if (!resolved.startsWith('xl/') || resolved.includes('\\'))
    throw new ImportParseError('invalid', 'XLSX 工作表路径无效');
  return resolved;
}

async function parseWorkbook(
  zip: ZipFile,
  signal: AbortSignal,
): Promise<ImportPlan> {
  const entries = await archiveEntries(zip, signal);
  const required = (name: string) => {
    const entry = entries.get(name);
    if (!entry) throw new ImportParseError('invalid', 'XLSX 工作簿内容不完整');
    return entry;
  };
  const workbook = new WorkbookXform();
  await readXml(
    zip,
    required('xl/workbook.xml'),
    MAX_METADATA_BYTES,
    signal,
    workbook,
  );
  const relationships = new RelationshipsXform();
  await readXml(
    zip,
    required('xl/_rels/workbook.xml.rels'),
    MAX_METADATA_BYTES,
    signal,
    relationships,
  );
  const sheetRelationship = (workbook.model.sheets || [])
    .map((sheet) => relationships.model.find((rel) => rel.Id === sheet.rId))
    .find(
      (rel) =>
        rel?.Type.endsWith('/worksheet') && rel.TargetMode !== 'External',
    );
  if (!sheetRelationship)
    throw new ImportParseError('invalid', 'Excel文件没有工作表');
  const sheetPath = relatedPath('xl/workbook.xml', sheetRelationship.Target);
  const sheetEntry = required(sheetPath);
  const strings = new SharedStringsXform();
  const sharedStringsEntry = entries.get('xl/sharedStrings.xml');
  if (sharedStringsEntry)
    await readXml(zip, sharedStringsEntry, MAX_SHARED_STRINGS_BYTES, signal, {
      parseOpen(node) {
        return strings.parseOpen(node);
      },
      parseText(text) {
        return strings.parseText(text);
      },
      parseClose(name) {
        strings.parseClose(name);
        if (strings.model.count > 500_000)
          throw new ImportParseError('capacity', 'XLSX 共享字符串超过限制');
      },
    });
  const styles = new StylesXform(true);
  const stylesEntry = entries.get('xl/styles.xml');
  if (stylesEntry)
    await readXml(zip, stylesEntry, MAX_METADATA_BYTES, signal, styles);
  const sheetRels = new RelationshipsXform();
  const sheetRelsEntry = entries.get(
    posix.join(
      posix.dirname(sheetPath),
      '_rels',
      `${posix.basename(sheetPath)}.rels`,
    ),
  );
  if (sheetRelsEntry)
    await readXml(zip, sheetRelsEntry, MAX_METADATA_BYTES, signal, sheetRels);
  const hyperlinkMap: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  const merges = new ImportMerges();
  const sheet = new ExcelJS.Workbook().addWorksheet('Import');
  let maxColumns = 0;
  let totalRows = 0;

  async function scan(
    onRow: (
      number: number,
      cells: string[],
      mergedTexts: (string | undefined)[],
    ) => void,
    collectMetadata: boolean,
  ) {
    const rowXform = new RowXform({ maxItems: IMPORT_MAX_COLUMNS });
    const options = {
      styles,
      sharedStrings: strings,
      date1904: workbook.model.properties.date1904,
      formulae: Object.create(null) as Record<string, string>,
      hyperlinkMap,
    };
    let insideRow = false;
    let rowNumber = 0;
    let dataRows = 0;
    let cellTextLength = 0;
    let textCharacters = 0;
    await readXml(zip, sheetEntry, MAX_SHEET_BYTES, signal, {
      parseOpen(node) {
        if (node.name === 'row') {
          const number = Number(node.attributes.r);
          if (
            insideRow ||
            !Number.isSafeInteger(number) ||
            number <= rowNumber ||
            number > IMPORT_MAX_SHEET_ROWS
          )
            throw new ImportParseError('invalid', 'XLSX 行号无效');
          rowNumber = number;
          insideRow = true;
        }
        if (insideRow) {
          if (node.name === 'c') {
            if (
              node.attributes.r &&
              cellAddress(node.attributes.r).row !== rowNumber
            )
              throw new ImportParseError('invalid', 'XLSX 单元格行号不一致');
            cellTextLength = 0;
          }
          rowXform.parseOpen(node);
        } else if (collectMetadata && node.name === 'mergeCell') {
          merges.add(node.attributes.ref);
        } else if (
          collectMetadata &&
          node.name === 'hyperlink' &&
          node.attributes['r:id']
        ) {
          const rel = sheetRels.model?.find(
            (entry) => entry.Id === node.attributes['r:id'],
          );
          if (!rel)
            throw new ImportParseError('invalid', 'XLSX 超链接关系无效');
          const address = cellAddress(node.attributes.ref);
          maxColumns = Math.max(maxColumns, address.column);
          hyperlinkMap[node.attributes.ref] = rel.Target;
        }
      },
      parseText(text) {
        if (insideRow) {
          cellTextLength += text.length;
          if (cellTextLength > IMPORT_MAX_CELL_LENGTH)
            throw new ImportParseError('capacity', '导入文件单元格超过限制');
          rowXform.parseText(text);
        }
      },
      parseClose(name) {
        if (!insideRow) return;
        rowXform.parseClose(name);
        if (name === 'row') {
          insideRow = false;
          rowXform.reconcile(rowXform.model, options);
          const row = new ExcelRow(sheet, rowNumber);
          row.model = rowXform.model;
          if (row.cellCount > IMPORT_MAX_COLUMNS)
            throw new ImportParseError('capacity', '导入文件列数超过限制');
          const cells = Array.from({ length: row.cellCount }, (_, index) =>
            String(row.getCell(index + 1).text ?? ''),
          );
          textCharacters += cells.reduce(
            (total, cell) => total + cell.length,
            0,
          );
          if (textCharacters > IMPORT_MAX_TEXT_CHARS)
            throw new ImportParseError('capacity', '导入文件展开文本超过限制');
          if (cells.some((cell) => cell.length > IMPORT_MAX_CELL_LENGTH))
            throw new ImportParseError('capacity', '导入文件单元格超过限制');
          if (
            rowNumber > 1 &&
            cells.some((cell) => cell.trim() !== '') &&
            ++dataRows > IMPORT_MAX_DATA_ROWS
          )
            throw new ImportParseError('capacity', '导入文件数据行超过限制');
          const mergedTexts = collectMetadata
            ? []
            : Array.from({ length: row.cellCount }, (_, index) => {
                const value = row.getCell(index + 1).value;
                return value == null ? undefined : String(value);
              });
          onRow(rowNumber, cells, mergedTexts);
        }
      },
    });
  }

  await scan((number, cells) => {
    totalRows = number;
    maxColumns = Math.max(maxColumns, cells.length);
  }, true);
  merges.prepare();
  totalRows = Math.max(totalRows, merges.maxRow);
  maxColumns = Math.max(maxColumns, merges.maxColumn);
  if (totalRows < 2)
    throw new ImportParseError('invalid', 'Excel文件至少需要包含表头和数据行');
  // Re-read header too: relationships after sheetData can change cell.text.
  let builder: ImportPlanBuilder | undefined;
  let processedRow = 0;
  const accept = (
    number: number,
    cells: string[],
    mergedTexts?: (string | undefined)[],
  ) => {
    signal.throwIfAborted();
    const merged = merges.apply(number, cells, mergedTexts);
    if (number === 1) builder = new ImportPlanBuilder(merged, maxColumns);
    else builder!.add(number, merged);
    processedRow = number;
  };
  await scan((number, cells, mergedTexts) => {
    for (let gap = processedRow + 1; gap < number; gap++) accept(gap, []);
    accept(number, cells, mergedTexts);
  }, false);
  for (let gap = processedRow + 1; gap <= totalRows; gap++) accept(gap, []);
  return builder!.finish(totalRows);
}

export async function parseXlsxFile(
  path: string,
  options: { signal?: AbortSignal } = {},
): Promise<ImportPlan> {
  const timeout = AbortSignal.timeout(IMPORT_PARSE_TIMEOUT_MS);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  let zip: ZipFile | undefined;
  let closed: Promise<void> | undefined;
  try {
    signal.throwIfAborted();
    const info = await stat(path);
    if (!info.isFile() || info.size > IMPORT_MAX_FILE_BYTES)
      throw new ImportParseError('capacity', '导入文件超过 10 MiB 限制');
    zip = await openPromise(path, {
      lazyEntries: true,
      autoClose: false,
      validateEntrySizes: true,
    });
    closed = new Promise<void>((resolve) => zip!.once('close', resolve));
    // eachEntry/read streams surface actionable failures; retain an error
    // listener through close so a concurrent I/O error cannot crash the process.
    zip.on('error', () => undefined);
    signal.throwIfAborted();
    return await parseWorkbook(zip, signal);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ImportParseError) throw error;
    throw new ImportParseError('invalid', 'XLSX文件无法解析');
  } finally {
    if (zip) {
      zip.close();
      await closed;
    }
  }
}
