import {
  findImportColumns,
  missingImportColumns,
  repairImportHeader,
  type ImportColumns,
} from './columns';

export class ImportParseError extends Error {
  constructor(readonly code: 'invalid' | 'capacity', message: string) {
    super(message);
    this.name = 'ImportParseError';
  }
}
export interface ImportRowError {
  row: number;
  message: string;
}
export interface ImportAsin {
  asin: string;
  name: string | null;
  asinType: '1' | '2' | null;
  site: string;
  brand: string;
}
export interface ImportGroup {
  name: string;
  country: string;
  site: string;
  brand: string;
  asins: ImportAsin[];
}
export interface ImportPlan {
  totalRows: number;
  totalDataRows: number;
  headers: string[];
  indexes: ImportColumns;
  groupedItems: ImportGroup[];
  errors: ImportRowError[];
}
export const IMPORT_MAX_DATA_ROWS = 100_000;
export const IMPORT_MAX_COLUMNS = 256;
export const IMPORT_MAX_CELL_LENGTH = 32767;
export const IMPORT_MAX_TEXT_CHARS = 32 * 1024 * 1024;

/** Adapters provide cell.text values and actual spreadsheet row numbers. Only
 * the compact business plan is retained, never a second matrix of all cells. */
export class ImportPlanBuilder {
  private readonly headers: string[];
  private readonly indexes: ImportColumns;
  private readonly groups = new Map<
    string,
    { group: ImportGroup; seen: Set<string> }
  >();
  private readonly errors: ImportRowError[] = [];
  private totalDataRows = 0;
  private totalRows = 1;
  private textCharacters = 0;
  constructor(rawHeaders: string[], maxColumns = rawHeaders.length) {
    if (
      !Number.isInteger(maxColumns) ||
      maxColumns < rawHeaders.length ||
      maxColumns > IMPORT_MAX_COLUMNS
    )
      throw new ImportParseError('capacity', '导入文件列数超过限制');
    this.checkCells(rawHeaders);
    this.headers = [
      ...rawHeaders.map(repairImportHeader),
      ...Array<string>(maxColumns - rawHeaders.length).fill(''),
    ];
    this.indexes = findImportColumns(this.headers);
    const missing = missingImportColumns(this.indexes);
    if (missing.length)
      throw new ImportParseError(
        'invalid',
        `Excel文件必须包含：${missing.join('、')}列`,
      );
  }
  private checkCells(cells: string[]) {
    if (
      cells.length > IMPORT_MAX_COLUMNS ||
      cells.some(
        (cell) =>
          typeof cell !== 'string' || cell.length > IMPORT_MAX_CELL_LENGTH,
      )
    )
      throw new ImportParseError('capacity', '导入文件单元格超过限制');
    this.textCharacters += cells.reduce(
      (total, cell) => total + cell.length,
      0,
    );
    if (this.textCharacters > IMPORT_MAX_TEXT_CHARS)
      throw new ImportParseError('capacity', '导入文件展开文本超过限制');
  }
  add(rowNumber: number, cells: string[]): void {
    if (!Number.isSafeInteger(rowNumber) || rowNumber <= this.totalRows)
      throw new ImportParseError('invalid', '导入文件行号无效');
    this.checkCells(cells);
    this.totalRows = rowNumber;
    if (!cells.some((cell) => cell.trim() !== '')) return;
    if (++this.totalDataRows > IMPORT_MAX_DATA_ROWS)
      throw new ImportParseError('capacity', '导入文件数据行超过限制');
    const indexes = this.indexes;
    const text = (index: number) => (cells[index] || '').trim();
    const name = text(indexes.groupNameIndex),
      country = text(indexes.countryIndex).toUpperCase(),
      site = text(indexes.siteIndex),
      brand = text(indexes.brandIndex),
      asin = text(indexes.asinIndex).toUpperCase(),
      asinName = text(indexes.asinNameIndex) || null,
      asinType = text(indexes.asinTypeIndex);
    let message: string | undefined;
    if (!name) message = '变体组名称不能为空';
    else if (!['US', 'UK', 'DE', 'FR', 'IT', 'ES'].includes(country))
      message = `国家代码无效: ${country}，必须是 US/UK/DE/FR/IT/ES 之一`;
    else if (!brand) message = '品牌不能为空';
    else if (!site) message = '站点（店铺代号）不能为空';
    else if (!asin) message = 'ASIN不能为空';
    else if (asinType && asinType !== '1' && asinType !== '2')
      message = `ASIN类型无效: ${asinType}，必须是 1（主链）或 2（副评）`;
    if (message) {
      this.errors.push({ row: rowNumber, message });
      return;
    }
    // Keep the historical group-key semantics while replacing the quadratic
    // within-group duplicate scan with a Set. Cross-group checks belong to DB planning.
    const key = `${name}__${country}__${site}__${brand}`;
    let entry = this.groups.get(key);
    if (!entry) {
      entry = {
        group: { name, country, site, brand, asins: [] },
        seen: new Set(),
      };
      this.groups.set(key, entry);
    }
    if (entry.seen.has(asin)) {
      this.errors.push({
        row: rowNumber,
        message: `ASIN ${asin} 在当前文件同一变体组中重复，跳过`,
      });
      return;
    }
    entry.seen.add(asin);
    entry.group.asins.push({
      asin,
      name: asinName,
      asinType: asinType === '1' || asinType === '2' ? asinType : null,
      site,
      brand,
    });
  }
  finish(totalRows = this.totalRows): ImportPlan {
    if (!Number.isSafeInteger(totalRows) || totalRows < this.totalRows)
      throw new ImportParseError('invalid', '导入文件行数无效');
    if (totalRows < 2)
      throw new ImportParseError(
        'invalid',
        'Excel文件至少需要包含表头和数据行',
      );
    return {
      totalRows,
      totalDataRows: this.totalDataRows,
      headers: this.headers,
      indexes: this.indexes,
      groupedItems: [...this.groups.values()].map(({ group }) => group),
      errors: this.errors,
    };
  }
}
