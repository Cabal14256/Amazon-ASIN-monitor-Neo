import {
  variantGroupListResultSchema,
  variantGroupResultSchema,
} from '@asin-monitor/contracts';
import type { AsinGroupReadResult } from '@asin-monitor/db';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  mapAsinQueryGroups,
  normalizeAsinType,
} from '../src/asin/asin-query-mapper';
import {
  fixtureAt,
  queryAsin,
  queryGroup,
} from './helpers/asin-query-fixtures';

const filename = resolve(
  __dirname,
  '../../../server/src/models/VariantGroup.js',
);
const nativeRequire = createRequire(filename);
function raw<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      typeof item === 'boolean' ? Number(item) : item,
    ]),
  );
}
function model(responses: unknown[][]) {
  const query = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('Unexpected Legacy fixture query');
    return structuredClone(next);
  });
  const module = {
    exports: {} as {
      findById(id: string): Promise<unknown>;
      findAll(value?: unknown): Promise<unknown>;
    },
  };
  vm.runInNewContext(
    readFileSync(filename, 'utf8'),
    {
      module,
      exports: module.exports,
      require: (name: string) => {
        if (name === '../config/database') return { query };
        if (name === '../utils/variantStatus') return nativeRequire(name);
        if (name === '../services/cacheService')
          return {
            getAsync: async () => null,
            setAsync: async () => undefined,
          };
        if (name === '../utils/logger')
          return { info() {}, debug() {}, warn() {}, error() {} };
        if (name === 'uuid') return { v4: () => 'fixture-unused-id' };
        if (name === './MonitorHistory') return {};
        throw new Error('Unexpected Legacy fixture dependency');
      },
    },
    { filename },
  );
  return { model: module.exports, query };
}
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
describe('ASIN response mapping / actual Legacy model', () => {
  it.each([false, true, null])(
    'matches complete detail JSON with parent manual=%s',
    async (manualBroken) => {
      const group = queryGroup({
        manualBroken,
        manualBrokenReason: 'Group exception',
        manualBrokenUpdatedAt: fixtureAt,
        manualBrokenUpdatedBy: 'fixture-actor',
        feishuNotifyEnabled: null,
      });
      const asins = [
        queryAsin({
          manualExcludedFromGroup: true,
          manualExcludedReason: 'Exclusion',
          asinType: 'MAIN_LINK',
        }),
        queryAsin({
          id: 'a2',
          asin: 'B000000084',
          isBroken: true,
          manualBroken: true,
          manualBrokenReason: 'Own exception',
          manualBrokenUpdatedAt: fixtureAt,
          asinType: 'SUB_REVIEW',
          feishuNotifyEnabled: null,
        }),
      ];
      const f = model([[raw(group)], asins.map(raw)]);
      const expected = json(await f.model.findById(group.id));
      const actual = mapAsinQueryGroups({
        groups: [group],
        asins,
        total: 0,
        totalASINs: 0,
      })[0];
      expect(actual).toEqual(expected);
      variantGroupResultSchema.parse({
        success: true,
        errorCode: 0,
        data: actual,
      });
      expect(f.query).toHaveBeenCalledTimes(2);
    },
  );
  it('retains all children while asin_count may count only the keyword-matching child', async () => {
    const group = queryGroup();
    const asins = [
      queryAsin(),
      queryAsin({ id: 'a2', asin: 'B000000084', manualBroken: true }),
    ];
    const f = model([
      [{ total: 1 }],
      [{ total: 1 }],
      [{ ...raw(group), asin_count: 1 }],
      asins.map(raw),
    ]);
    const expected = json(
      await f.model.findAll({
        keyword: 'B000000083',
        current: 1,
        pageSize: 10,
      }),
    );
    const result: AsinGroupReadResult = {
      groups: [{ ...group, asinCount: 1 }],
      asins,
      total: 1,
      totalASINs: 1,
    };
    const actual = {
      list: mapAsinQueryGroups(result),
      total: 1,
      totalASINs: 1,
      current: 1,
      pageSize: 10,
    };
    expect(actual).toEqual(expected);
    variantGroupListResultSchema.parse({
      success: true,
      errorCode: 0,
      data: actual,
    });
    expect(actual.list[0].children).toHaveLength(2);
  });
  it('preserves nullable historical creation/update times in both aliases and in children', async () => {
    const group = queryGroup({ createTime: null, updateTime: null });
    const asin = queryAsin({ createTime: null, updateTime: null });
    const f = model([[raw(group)], [raw(asin)]]);
    const actual = mapAsinQueryGroups({
      groups: [group],
      asins: [asin],
      total: 0,
      totalASINs: 0,
    })[0];
    expect(actual).toEqual(json(await f.model.findById(group.id)));
    variantGroupResultSchema.parse({
      success: true,
      errorCode: 0,
      data: actual,
    });
  });
  it.each([
    [null, null],
    ['1', '1'],
    [' 2 ', '2'],
    ['MAIN_LINK', '1'],
    ['SUB_REVIEW', '2'],
    ['main_link', null],
    ['bad', null],
  ])('normalizes legacy ASIN type %s', (value, expected) => {
    expect(normalizeAsinType(value)).toBe(expected);
  });
});
