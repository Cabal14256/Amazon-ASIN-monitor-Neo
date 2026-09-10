import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ImportPlan } from '../src/rows';
import { parseXlsxFile } from '../src/xlsx';

const legacyPath = resolve(
  __dirname,
  '../../../server/src/services/importParserService.js',
);
const legacy = createRequire(legacyPath)(legacyPath) as {
  parseImportFile(file: {
    originalname: string;
    buffer: Buffer;
  }): Promise<ImportPlan>;
};
const header = [
  '变体组名称',
  '国家',
  '站点',
  '品牌',
  'ASIN',
  'ASIN类型',
  'ASIN名称',
];
const row = (index: number) => [
  '主营组',
  'US',
  '店铺',
  '品牌',
  `B${index.toString().padStart(9, '0')}`,
  '1',
  '产品',
];
const dirs: string[] = [];
async function file(bytes: Buffer) {
  const dir = await mkdtemp(join(tmpdir(), 'neo-import-xlsx-'));
  dirs.push(dir);
  const path = join(dir, 'fixture.xlsx');
  await writeFile(path, bytes);
  return path;
}
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function workbook(
  setup?: (book: ExcelJS.Workbook, sheet: ExcelJS.Worksheet) => void,
) {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('主营');
  sheet.addRow(header);
  sheet.addRow(row(1));
  setup?.(book, sheet);
  return Buffer.from(await book.xlsx.writeBuffer());
}
async function compare(buffer: Buffer) {
  const expected = await legacy.parseImportFile({
    originalname: 'fixture.xlsx',
    buffer,
  });
  const actual = await parseXlsxFile(await file(buffer));
  expect(actual).toEqual(expected);
  return actual;
}
async function editXml(
  buffer: Buffer,
  name: string,
  edit: (xml: string) => string,
) {
  const zip = await JSZip.loadAsync(buffer);
  zip.file(name, edit(await zip.file(name)!.async('string')));
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

describe('real XLSX bytes compared with the actual Legacy document reader', () => {
  it('imports records, duplicates and row errors in the same order', async () => {
    const actual = await compare(
      await workbook((_book, sheet) => {
        sheet.addRow(row(1));
        sheet.addRow(row(2));
        sheet.addRow(['Invalid', 'CA', '', '', 'x', '3']);
      }),
    );
    expect(actual.groupedItems[0].asins).toHaveLength(2);
    expect(actual.errors.map((error) => error.row)).toEqual([3, 5]);
  });
  it.each([false, true])(
    'preserves rich text, formulas, dates and hyperlinks with date1904=%s',
    async (date1904) => {
      const values: ExcelJS.CellValue[] = [
        { richText: [{ text: '富' }, { font: { bold: true }, text: '文本' }] },
        new Date('2024-01-02T03:04:05Z'),
        { formula: '1+1', result: 2 },
        { formula: '1-1', result: 0 },
        { formula: 'FALSE()', result: false },
        { formula: 'TRUE()', result: true },
        { formula: '1/0', result: { error: '#DIV/0!' } },
        { formula: '"name"', result: 'Name' },
        { text: 'Link name', hyperlink: 'https://example.com/product' },
        { error: '#N/A' },
        true,
        123,
      ];
      const actual = await compare(
        await workbook((book, sheet) => {
          book.properties.date1904 = date1904;
          values.forEach((value, index) => {
            const data = sheet.addRow(row(index + 2));
            data.getCell(7).value = value;
          });
        }),
      );
      expect(actual.errors).toEqual([]);
      expect(actual.groupedItems[0].asins).toHaveLength(values.length + 1);
    },
  );
  it('handles inline rich strings with the same document decoder', async () => {
    const bytes = await editXml(
      await workbook(),
      'xl/worksheets/sheet1.xml',
      (xml) =>
        xml.replace(
          /<c r="G2"[^>]*>.*?<\/c>/,
          '<c r="G2" t="inlineStr"><is><r><t>inline </t></r><r><t>rich</t></r></is></c>',
        ),
    );
    const actual = await compare(bytes);
    expect(actual.groupedItems[0].asins[0].name).toBe('inline rich');
  });
  it('uses the first logical worksheet even when it is sheet2.xml in the ZIP', async () => {
    const source = await workbook((book) => {
      const second = book.addWorksheet('第一张业务表');
      second.addRows([header, ['另一组', ...row(2).slice(1)]]);
    });
    const bytes = await editXml(source, 'xl/workbook.xml', (xml) =>
      xml.replace(/(<sheet [^>]+\/>)(<sheet [^>]+\/>)/, '$2$1'),
    );
    const actual = await compare(bytes);
    expect(actual.groupedItems[0].name).toBe('另一组');
  });
  it('preserves merged group columns, sparse merged rows and horizontal merges', async () => {
    const actual = await compare(
      await workbook((_book, sheet) => {
        sheet.addRow(row(2));
        sheet.addRow(row(3));
        for (const column of ['A', 'B', 'C', 'D'])
          sheet.mergeCells(`${column}2:${column}4`);
        sheet.mergeCells('G2:H2');
        sheet.getCell('A5').value = 'Merged group';
        sheet.mergeCells('A5:A6');
      }),
    );
    expect(actual.groupedItems[0].asins).toHaveLength(3);
    expect(actual.totalRows).toBe(6);
  });
  it('preserves the different master/slave text of merged rich text and formula cells', async () => {
    await compare(
      await workbook((_book, sheet) => {
        sheet.addRow(row(2));
        sheet.addRow(row(3));
        sheet.addRow(row(4));
        sheet.getCell('G2').value = {
          richText: [{ text: 'rich' }, { text: ' name' }],
        };
        sheet.mergeCells('G2:G3');
        sheet.getCell('G4').value = { formula: '"Name"', result: 'Name' };
        sheet.mergeCells('G4:G5');
      }),
    );
  });
  it('rejects null merged masters with a safe error where Legacy cell.text throws', async () => {
    const bytes = await workbook((_book, sheet) => sheet.mergeCells('A5:A6'));
    await expect(
      legacy.parseImportFile({ originalname: 'fixture.xlsx', buffer: bytes }),
    ).rejects.toThrow();
    await expect(parseXlsxFile(await file(bytes))).rejects.toMatchObject({
      code: 'invalid',
      message: 'XLSX 合并单元格主值为空',
    });
  });
  it('preserves sparse row numbers and late columns used by header fallback', async () => {
    const actual = await compare(
      await workbook((_book, sheet) => {
        sheet.getRow(10000).values = row(2);
        sheet.getCell('J10000').value = 'extra';
      }),
    );
    expect(actual.totalRows).toBe(10000);
    expect(actual.totalDataRows).toBe(2);
    expect(actual.headers).toHaveLength(10);
  });
  it('retains cached results of shared formulas without retaining prior rows', async () => {
    const actual = await compare(
      await workbook((_book, sheet) => {
        sheet.addRow(row(2));
        const shared: ExcelJS.CellFormulaValue & {
          shareType: 'shared';
          ref: string;
        } = {
          formula: 'E2',
          result: 'B000000001',
          shareType: 'shared',
          ref: 'G2:G3',
        };
        sheet.getCell('G2').value = shared;
        sheet.getCell('G3').value = {
          sharedFormula: 'G2',
          result: 'B000000002',
        };
      }),
    );
    expect(actual.groupedItems[0].asins.map((asin) => asin.name)).toEqual([
      'B000000001',
      'B000000002',
    ]);
  });
  it('rejects malformed XML and releases the file', async () => {
    const bytes = await editXml(
      await workbook(),
      'xl/worksheets/sheet1.xml',
      (xml) => xml.slice(0, -20),
    );
    const path = await file(bytes);
    await expect(parseXlsxFile(path)).rejects.toMatchObject({
      code: 'invalid',
    });
    await rename(path, `${path}.released`);
  });
  it('rejects expansion beyond the worksheet byte bound before loading XML', async () => {
    const zip = await JSZip.loadAsync(await workbook());
    zip.file('xl/worksheets/sheet1.xml', ' '.repeat(64 * 1024 * 1024 + 1));
    const path = await file(
      await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }),
    );
    await expect(parseXlsxFile(path)).rejects.toMatchObject({
      code: 'capacity',
    });
    await rename(path, `${path}.released`);
  }, 15_000);
  it('rejects oversized columns, cells, merges and XML document type declarations', async () => {
    const source = await workbook();
    const edits = [
      (xml: string) => xml.replace('r="G2"', 'r="IW2"'),
      (xml: string) =>
        xml.replace(
          /<c r="G2"[^>]*>.*?<\/c>/,
          `<c r="G2" t="inlineStr"><is><t>${'x'.repeat(32768)}</t></is></c>`,
        ),
      (xml: string) =>
        xml.replace(
          '</worksheet>',
          '<mergeCells count="1"><mergeCell ref="A1:A1048576"/></mergeCells></worksheet>',
        ),
      (xml: string) =>
        xml.replace('<worksheet', '<!DOCTYPE worksheet><worksheet'),
    ];
    for (const edit of edits)
      await expect(
        parseXlsxFile(
          await file(await editXml(source, 'xl/worksheets/sheet1.xml', edit)),
        ),
      ).rejects.toBeInstanceOf(Error);
  });
  it('stops active XLSX reading on cancellation without leaving a locked file', async () => {
    const path = await file(
      await workbook((_book, sheet) => {
        for (let i = 2; i < 10000; i++) sheet.addRow(row(i));
      }),
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10);
    try {
      await expect(
        parseXlsxFile(path, { signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      await rename(path, `${path}.released`);
    } finally {
      clearTimeout(timer);
    }
  }, 15_000);
});
