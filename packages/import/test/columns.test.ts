import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  findImportColumns,
  missingImportColumns,
  repairImportHeader,
} from '../src/columns';

const source = readFileSync(
  resolve(__dirname, '../../../server/src/services/importParserService.js'),
  'utf8',
);
const legacyModule = {
  exports: {} as {
    findColumnIndexes(
      headers: string[],
      options: { withSite: boolean },
    ): ReturnType<typeof findImportColumns>;
    repairHeaderText(value: unknown): string;
  },
};
runInNewContext(
  source + '\nmodule.exports = { findColumnIndexes, repairHeaderText };',
  {
    module: legacyModule,
    Buffer,
    require: (name: string) => {
      if (['exceljs', 'iconv-lite', 'path', 'stream'].includes(name)) return {};
      throw new Error('Unexpected Legacy header dependency');
    },
  },
);

describe('import header rules against the actual Legacy parser', () => {
  const headers = [
    ['变体组名称', '国家', '站点', '品牌', 'ASIN', 'ASIN名称', 'ASIN类型'],
    [
      'Variant Group',
      'Country',
      'Site',
      'Brand',
      'ASIN',
      'ASIN Name',
      'ASIN Type',
    ],
    ['Name', 'Area', 'Shop', 'Brand Name', 'Code', 'Product', 'Category'],
    ['变体', '国别', '站', '品类', '子asin', '产品名称'],
    ['组名称', '国家', '店铺site', '品牌', 'ASIN', '', '', ''],
    ['Group', 'Country', 'Site', 'Brand', 'ASIN', 'ASIN Name'],
    ['', '', '', '', '', '', ''],
    ['ASIN Type', 'ASIN Name', 'Brand', 'Site', 'Country', 'ASIN', 'Group'],
    ['组', '国家', '站点', '品牌', 'ASIN', 'group name', 'variant type'],
  ];
  it.each(headers.map((value) => [value] as const))(
    'matches complete indexes for %j',
    (value) => {
      expect(findImportColumns([...value])).toEqual(
        legacyModule.exports.findColumnIndexes([...value], { withSite: true }),
      );
    },
  );
  it('preserves the trailing-column fallback, including historical name/type overlap', () => {
    const value = ['Group', 'Country', 'Site', 'Brand', 'ASIN', 'ASIN Name'];
    expect(findImportColumns(value)).toMatchObject({
      asinNameIndex: 5,
      asinTypeIndex: 5,
    });
    expect(findImportColumns([...value, '', '', ''])).toMatchObject({
      asinNameIndex: 5,
      asinTypeIndex: 7,
    });
  });
  it('reports missing required columns in Legacy validation order', () => {
    expect(missingImportColumns(findImportColumns([]))).toEqual([
      '变体组名称',
      '国家',
      'ASIN',
      '品牌',
      '站点',
    ]);
  });
  it.each([
    '  变体组名称  ',
    'ASIN',
    '',
    null,
    0,
    '±äÌå×éÃû³Æ',
    Buffer.from('变体组名称').toString('latin1'),
  ])('matches Legacy header repair for %j', (value) => {
    expect(repairImportHeader(value)).toBe(
      legacyModule.exports.repairHeaderText(value),
    );
  });
});
