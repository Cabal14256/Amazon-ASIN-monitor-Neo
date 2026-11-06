import { describe, expect, it } from 'vitest';
import {
  VARIANT_GROUP_EXPORT_HEADER,
  VARIANT_GROUP_EXPORT_SHEET,
  VARIANT_GROUP_EXPORT_WIDTHS,
  variantGroupExportRow,
  type VariantGroupExportFields,
} from '../src/variant-group-export-rows';

const legacyFixture = {
  sheet: '变体组数据',
  header: [
    '变体组名称',
    '变体组ID',
    '国家',
    '站点',
    '品牌',
    '变体状态',
    'ASIN数量',
    '异常ASIN数量',
    '创建时间',
    '更新时间',
    '最后检查时间',
  ],
  widths: [30, 40, 10, 10, 15, 10, 10, 12, 20, 20, 20],
  fields: {
    name: 'US 主营组',
    id: 'group-us',
    country: 'US',
    site: 'amazon.com',
    brand: 'Fixture',
    isBroken: 1,
    asinCount: 3,
    brokenAsinCount: 1,
    createTime: '2026-09-27 00:00:00.123',
    updateTime: '2026-09-28 01:02:03.456',
    lastCheckTime: '2026-09-29 04:05:06',
  },
};

describe('variant group export rows', () => {
  it('matches the Legacy asynchronous export sheet, columns, widths, and dates', () => {
    expect(VARIANT_GROUP_EXPORT_SHEET).toBe(legacyFixture.sheet);
    expect([...VARIANT_GROUP_EXPORT_HEADER]).toEqual(legacyFixture.header);
    expect([...VARIANT_GROUP_EXPORT_WIDTHS]).toEqual(legacyFixture.widths);

    const row = variantGroupExportRow(
      legacyFixture.fields satisfies VariantGroupExportFields,
    );
    expect(row).toEqual([
      'US 主营组',
      'group-us',
      'US',
      'amazon.com',
      'Fixture',
      '异常',
      3,
      1,
      new Date('2026-09-27T00:00:00.123+08:00'),
      new Date('2026-09-28T01:02:03.456+08:00'),
      new Date('2026-09-29T04:05:06+08:00'),
    ]);
  });

  it('preserves empty strings and zero counts while mapping nulls to empty cells', () => {
    const row = variantGroupExportRow({
      name: '',
      id: '',
      country: '',
      site: '',
      brand: '',
      isBroken: false,
      asinCount: 0,
      brokenAsinCount: 0,
      createTime: null,
      updateTime: '',
      lastCheckTime: null,
    });

    expect(row).toEqual(['', '', '', '', '', '正常', 0, 0, '', '', '']);
  });

  it('rejects invalid non-empty timestamps', () => {
    expect(() =>
      variantGroupExportRow({
        ...legacyFixture.fields,
        createTime: 'not-a-timestamp',
      }),
    ).toThrow(RangeError);
  });
});
