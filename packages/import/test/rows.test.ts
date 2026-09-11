import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { ImportPlanBuilder, type ImportPlan } from '../src/rows';

const header = ['变体组名称', '国家', '站点', '品牌', 'ASIN', 'ASIN类型'];
const row = (group = 'Group', asin = 'b000000001') => [
  group,
  ' us ',
  ' shop ',
  ' Brand ',
  asin,
  '1',
];

/** Execute the full old parser; replace only the spreadsheet I/O adapter with
 * the same cell.text matrix supplied to the streaming plan builder. */
async function legacy(rows: string[][]): Promise<ImportPlan> {
  const module = {
    exports: {} as {
      parseImportFile(file: {
        originalname: string;
        buffer: Buffer;
      }): Promise<ImportPlan>;
    },
  };
  class Workbook {
    worksheets = [
      {
        eachRow(_options: unknown, callback: (row: unknown) => void) {
          rows.forEach((cells) =>
            callback({
              values: [undefined, ...cells],
              cellCount: cells.length,
              getCell: (index: number) => ({ text: cells[index - 1] ?? '' }),
            }),
          );
        },
      },
    ];
    xlsx = { load: async () => undefined };
  }
  const source = readFileSync(
    resolve(__dirname, '../../../server/src/services/importParserService.js'),
    'utf8',
  );
  runInNewContext(source, {
    module,
    Buffer,
    require: (name: string) => {
      if (name === 'exceljs') return { Workbook };
      if (name === 'path') return { extname: () => '.xlsx' };
      if (name === 'iconv-lite' || name === 'stream') return {};
      throw new Error('Unexpected parser fixture dependency');
    },
  });
  return JSON.parse(
    JSON.stringify(
      await module.exports.parseImportFile({
        originalname: 'fixture.xlsx',
        buffer: Buffer.alloc(0),
      }),
    ),
  );
}
function plan(rows: string[][]) {
  const builder = new ImportPlanBuilder(
    rows[0],
    Math.max(...rows.map((cells) => cells.length)),
  );
  rows.slice(1).forEach((cells, index) => builder.add(index + 2, cells));
  return builder.finish(rows.length);
}
describe('streaming import plan against complete Legacy row results', () => {
  const cases: [string, string[][]][] = [
    [
      'normal and file order',
      [header, row('B'), row('A', 'b000000002'), row('B', 'b000000003')],
    ],
    [
      'same-group and cross-group duplicates',
      [header, row(), row(), row('Other')],
    ],
    [
      'blank rows and cell trimming',
      [header, [], [' ', '', '', ''], row(), []],
    ],
    [
      'validation priority',
      [
        header,
        ['', '', '', '', '', ''],
        [' ', 'CA', 'Shop', 'Brand', 'a', '3'],
        ['Group', 'CA', '', '', '', '3'],
        ['Group', 'US', '', '', '', '3'],
        ['Group', 'US', '', 'Brand', '', '3'],
        ['Group', 'US', 'Shop', 'Brand', '', '3'],
        ['Group', 'US', 'Shop', 'Brand', 'a', '3'],
      ],
    ],
    [
      'parser defers strict ASIN checks to writing',
      [header, row('Group', 'invalid'), row('Group', '123')],
    ],
    [
      'optional names and types',
      [
        [...header, 'ASIN名称'],
        [...row().slice(0, 5), '', ''],
        [...row('Other').slice(0, 5), '2', ' Product '],
      ],
    ],
    ['empty data still has a row', [header, []]],
    [
      'header width considers later rows',
      [[...header.slice(0, 6)], [...row().slice(0, 6), '', '', '']],
    ],
    [
      'historical delimiter collision',
      [
        header,
        ['a__US__b', 'US', 'c', 'd', 'B000000001', '1'],
        ['a', 'US', 'b__US__c', 'd', 'B000000002', '2'],
      ],
    ],
  ];
  it.each(cases)(
    '%s matches full plan, error order and row numbers',
    async (_name, rows) => {
      expect(plan(rows)).toEqual(await legacy(rows));
    },
  );
  it('imports valid records from the actual six-column UI template', () => {
    const result = plan([
      header,
      row('B'),
      row('A', 'b000000002'),
      row('B', 'b000000003'),
    ]);
    expect(result.errors).toEqual([]);
    expect(
      result.groupedItems.map((group) => [
        group.name,
        group.asins.map((asin) => asin.asin),
      ]),
    ).toEqual([
      ['B', ['B000000001', 'B000000003']],
      ['A', ['B000000002']],
    ]);
    expect(result.groupedItems[0].asins[0]).toMatchObject({
      name: null,
      asinType: '1',
    });
  });
  it('accepts sparse spreadsheet row numbers without allocating intermediate empty rows', () => {
    const builder = new ImportPlanBuilder(header);
    builder.add(10000, row());
    expect(builder.finish()).toMatchObject({
      totalRows: 10000,
      totalDataRows: 1,
      errors: [],
    });
  });
  it('rejects column and cell resource overflow without silent truncation', () => {
    expect(() => new ImportPlanBuilder(header, 257)).toThrow('列数超过限制');
    expect(() =>
      new ImportPlanBuilder(header).add(2, ['x'.repeat(32768)]),
    ).toThrow('单元格超过限制');
  });
  it('bounds expanded shared/merged text even when the physical input is small', () => {
    const builder = new ImportPlanBuilder(header);
    const largeRow = row('x'.repeat(32767));
    expect(() => {
      for (let number = 2; number < 2000; number++)
        builder.add(number, largeRow);
    }).toThrow('展开文本超过限制');
  });
  it('rejects missing header and out-of-order adapter rows before creating a plan', () => {
    expect(() => new ImportPlanBuilder([])).toThrow('必须包含');
    const builder = new ImportPlanBuilder(header);
    builder.add(3, row());
    expect(() => builder.add(2, row())).toThrow('行号无效');
  });
});
