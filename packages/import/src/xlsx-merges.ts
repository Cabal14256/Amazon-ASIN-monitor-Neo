import { IMPORT_MAX_COLUMNS, ImportParseError } from './rows';

export const IMPORT_MAX_SHEET_ROWS = 1_048_576;
export function cellAddress(address: string): { row: number; column: number } {
  const match = /^([A-Z]+)([1-9][0-9]*)$/.exec(address);
  if (!match) throw new ImportParseError('invalid', 'XLSX 单元格地址无效');
  let column = 0;
  for (const char of match[1]) {
    column = column * 26 + char.charCodeAt(0) - 64;
    if (column > IMPORT_MAX_COLUMNS)
      throw new ImportParseError('capacity', '导入文件列数超过限制');
  }
  const row = Number(match[2]);
  if (!Number.isSafeInteger(row) || row > IMPORT_MAX_SHEET_ROWS)
    throw new ImportParseError('capacity', '导入文件行数超过限制');
  return { row, column };
}

interface MergeRange {
  top: number;
  bottom: number;
  left: number;
  right: number;
  text?: string;
}
export class ImportMerges {
  private readonly ranges: MergeRange[] = [];
  private readonly starts = new Map<number, MergeRange[]>();
  private active: MergeRange[] = [];
  private cells = 0;
  maxRow = 0;
  maxColumn = 0;
  add(ref: string) {
    const [start, end = start, extra] = ref.split(':');
    if (extra !== undefined)
      throw new ImportParseError('invalid', 'XLSX 合并单元格无效');
    const a = cellAddress(start),
      b = cellAddress(end);
    const range = {
      top: Math.min(a.row, b.row),
      bottom: Math.max(a.row, b.row),
      left: Math.min(a.column, b.column),
      right: Math.max(a.column, b.column),
    };
    this.cells +=
      (range.bottom - range.top + 1) * (range.right - range.left + 1);
    if (this.ranges.length >= 10_000 || this.cells > 1_000_000)
      throw new ImportParseError('capacity', 'XLSX 合并单元格超过限制');
    this.ranges.push(range);
    this.maxRow = Math.max(this.maxRow, range.bottom);
    this.maxColumn = Math.max(this.maxColumn, range.right);
  }
  prepare() {
    const byColumn = new Map<number, MergeRange[]>();
    for (const range of this.ranges) {
      const starts = this.starts.get(range.top) || [];
      starts.push(range);
      this.starts.set(range.top, starts);
      for (let col = range.left; col <= range.right; col++) {
        const ranges = byColumn.get(col) || [];
        ranges.push(range);
        byColumn.set(col, ranges);
      }
    }
    for (const ranges of byColumn.values()) {
      ranges.sort((a, b) => a.top - b.top);
      for (let i = 1; i < ranges.length; i++)
        if (ranges[i].top <= ranges[i - 1].bottom)
          throw new ImportParseError('invalid', 'XLSX 合并单元格重叠');
    }
  }
  apply(
    number: number,
    cells: string[],
    mergedTexts: (string | undefined)[] = [],
  ) {
    this.active = this.active.filter((range) => range.bottom >= number);
    for (const range of this.starts.get(number) || []) {
      range.text = mergedTexts[range.left - 1];
      if (
        range.text === undefined &&
        (range.top !== range.bottom || range.left !== range.right)
      )
        throw new ImportParseError('invalid', 'XLSX 合并单元格主值为空');
      this.active.push(range);
    }
    for (const range of this.active) {
      while (cells.length < range.right) cells.push('');
      for (let col = range.left; col <= range.right; col++)
        if (number !== range.top || col !== range.left)
          cells[col - 1] = range.text || '';
    }
    return cells;
  }
}
