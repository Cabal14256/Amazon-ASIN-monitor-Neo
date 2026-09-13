import {
  competitorGroupListResultSchema,
  competitorGroupResultSchema,
} from '@asin-monitor/contracts';
import type {
  CompetitorAsin,
  CompetitorGroupReadResult,
  CompetitorVariantGroup,
} from '@asin-monitor/db';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { mapCompetitorQueryGroups } from '../src/competitor/competitor-query-mapper';

const at = new Date('2026-09-13T16:00:00Z');
const group = (
  values: Partial<CompetitorVariantGroup> = {},
): CompetitorVariantGroup => ({
  id: 'group-119',
  name: '竞品组',
  country: 'US',
  brand: '合成品牌',
  isBroken: false,
  variantStatus: 'NORMAL',
  feishuNotifyEnabled: false,
  createTime: at,
  updateTime: at,
  lastCheckTime: null,
  ...values,
});
const asin = (values: Partial<CompetitorAsin> = {}): CompetitorAsin => ({
  id: 'asin-119',
  asin: 'B000000119',
  name: '合成商品',
  country: 'US',
  brand: '合成品牌',
  variantGroupId: 'group-119',
  asinType: '1',
  isBroken: false,
  variantStatus: 'NORMAL',
  feishuNotifyEnabled: false,
  createTime: at,
  updateTime: at,
  lastCheckTime: null,
  ...values,
});
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
const raw = (value: object) =>
  Object.fromEntries(
    Object.entries(value).map(([key, value]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      typeof value === 'boolean' ? Number(value) : value,
    ]),
  );
function legacy(responses: unknown[][]) {
  const query = vi.fn(async () => {
    const response = responses.shift();
    if (!response) throw new Error('Unexpected Legacy fixture query');
    return structuredClone(response);
  });
  const filename = resolve(
    __dirname,
    '../../../server/src/models/CompetitorVariantGroup.js',
  );
  const module = {
    exports: {} as {
      findAll(value?: unknown): Promise<unknown>;
      findById(id: string): Promise<unknown>;
    },
  };
  vm.runInNewContext(
    readFileSync(filename, 'utf8'),
    {
      module,
      exports: module.exports,
      require: (name: string) => {
        if (name === '../config/competitor-database') return { query };
        if (name === '../services/cacheService')
          return { getAsync: async () => null, setAsync: async () => {} };
        if (name === '../utils/logger')
          return { info() {}, debug() {}, warn() {}, error() {} };
        if (name === 'uuid') return { v4: () => 'unused-fixture-id' };
        throw new Error('Unexpected Legacy fixture dependency');
      },
    },
    { filename },
  );
  return { model: module.exports, query };
}
describe('competitor response mapping / complete actual Legacy model', () => {
  for (const parent of [false, true, null]) {
    for (const child of [false, true, null]) {
      it.each([false, true, null])(
        `preserves parent=${parent}, child=${child}, notify=%s in list and detail`,
        async (notify) => {
          const g = group({
            isBroken: parent,
            variantStatus: 'BROKEN',
            feishuNotifyEnabled: notify,
          });
          const children = [
            asin({
              isBroken: child,
              variantStatus: 'OTHER',
              feishuNotifyEnabled: notify,
              name: null,
            }),
          ];
          const data: CompetitorGroupReadResult = {
            groups: [g],
            asins: children,
            total: 1,
            totalASINs: 1,
          };
          const detail = legacy([[raw(g)], children.map(raw)]);
          const result = mapCompetitorQueryGroups(data)[0];
          expect(result).toEqual(json(await detail.model.findById(g.id)));
          competitorGroupResultSchema.parse({
            success: true,
            errorCode: 0,
            data: result,
          });
          expect(result).not.toHaveProperty('site');
          expect(result).not.toHaveProperty('manual_broken');
          const list = legacy([
            [{ total: 1 }],
            [{ total: 1 }],
            [{ ...raw(g), asin_count: 1 }],
            children.map(raw),
          ]);
          const listResult = {
            list: mapCompetitorQueryGroups({
              ...data,
              groups: [{ ...g, asinCount: 1 }],
            }),
            total: 1,
            totalASINs: 1,
            current: 1,
            pageSize: 10,
          };
          expect(listResult).toEqual(json(await list.model.findAll()));
          competitorGroupListResultSchema.parse({
            success: true,
            errorCode: 0,
            data: listResult,
          });
        },
      );
    }
  }
  it.each([
    null,
    '',
    '1',
    '2',
    'MAIN_LINK',
    'SUB_REVIEW',
    ' MAIN_LINK ',
    'unknown',
  ])('preserves ASIN type %s and nullable D8 timestamps', async (asinType) => {
    const g = group({ createTime: null, updateTime: null, lastCheckTime: at });
    const a = asin({
      asinType,
      createTime: null,
      updateTime: null,
      lastCheckTime: at,
    });
    const model = legacy([[raw(g)], [raw(a)]]);
    const actual = mapCompetitorQueryGroups({
      groups: [g],
      asins: [a],
      total: 0,
      totalASINs: 0,
    })[0];
    expect(actual).toEqual(json(await model.model.findById(g.id)));
    competitorGroupResultSchema.parse({
      success: true,
      errorCode: 0,
      data: actual,
    });
  });
  it('keeps an empty stored-broken group displayed as NORMAL and all children despite filtered asin_count', async () => {
    const groups = [
      group({ id: 'empty', isBroken: true }),
      group({ id: 'populated' }),
    ];
    const children = [
      asin({ variantGroupId: 'populated' }),
      asin({
        id: 'second',
        asin: 'B000000120',
        variantGroupId: 'populated',
        isBroken: true,
      }),
    ];
    const model = legacy([
      [{ total: 2 }],
      [{ total: 1 }],
      groups.map((g) => ({ ...raw(g), asin_count: g.id === 'empty' ? 0 : 1 })),
      children.map(raw),
    ]);
    const actual = {
      list: mapCompetitorQueryGroups({
        groups: groups.map((g) => ({
          ...g,
          asinCount: g.id === 'empty' ? 0 : 1,
        })),
        asins: children,
        total: 2,
        totalASINs: 1,
      }),
      total: 2,
      totalASINs: 1,
      current: 1,
      pageSize: 10,
    };
    expect(actual).toEqual(
      json(await model.model.findAll({ keyword: 'B000000119' })),
    );
    expect(actual.list[0]?.isBroken).toBe(0);
    expect(actual.list[1]?.children).toHaveLength(2);
    expect(actual.list[1]?.isBroken).toBe(1);
  });
});
