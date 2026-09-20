import { competitorAsinRecordResultSchema } from '@asin-monitor/contracts';
import type { CompetitorAsin } from '@asin-monitor/db';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { mapCompetitorAsinWrite } from '../src/competitor/competitor-write-mapper';

const filename = resolve(
  __dirname,
  '../../../server/src/models/CompetitorASIN.js',
);
async function legacyRecord(asin: CompetitorAsin) {
  const row = Object.fromEntries(
    Object.entries(asin).map(([key, value]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      typeof value === 'boolean' ? Number(value) : value,
    ]),
  );
  const module = { exports: {} as { findById(id: string): Promise<unknown> } };
  vm.runInNewContext(
    readFileSync(filename, 'utf8'),
    {
      module,
      exports: module.exports,
      require: (name: string) => {
        if (name === '../config/competitor-database')
          return { query: async () => [row] };
        if (name === './CompetitorVariantGroup') return {};
        if (name === 'uuid') return { v4: () => 'unused-fixture' };
        throw new Error('Unexpected competitor fixture dependency');
      },
    },
    { filename },
  );
  return JSON.parse(JSON.stringify(await module.exports.findById(asin.id)));
}
function record(overrides: Partial<CompetitorAsin> = {}): CompetitorAsin {
  return {
    id: 'asin-121',
    asin: 'B000000121',
    name: null,
    asinType: 'SUB_REVIEW',
    country: 'US',
    brand: 'Own brand',
    variantGroupId: 'group-121',
    isBroken: false,
    variantStatus: 'NORMAL',
    feishuNotifyEnabled: false,
    createTime: new Date('2026-09-20T00:00:00Z'),
    updateTime: null,
    lastCheckTime: null,
    ...overrides,
  };
}
describe('competitor standalone ASIN response / actual Legacy model', () => {
  for (const isBroken of [false, true, null]) {
    for (const feishuNotifyEnabled of [false, true, null]) {
      it(`matches complete fields with broken=${isBroken}, notify=${feishuNotifyEnabled}`, async () => {
        const asin = record({ isBroken, feishuNotifyEnabled });
        const actual = mapCompetitorAsinWrite(asin);
        expect(actual).toEqual(await legacyRecord(asin));
        expect(actual).not.toHaveProperty('parentId');
        expect(actual).not.toHaveProperty('site');
        expect(actual).not.toHaveProperty('manualBroken');
        competitorAsinRecordResultSchema.parse({
          success: true,
          errorCode: 0,
          data: actual,
        });
      });
    }
  }
  it.each(['MAIN_LINK', 'SUB_REVIEW', '1', '2', ' 1 ', 'unknown', '', null])(
    'preserves stored type %s',
    async (asinType) => {
      const asin = record({
        asinType,
        createTime: null,
        updateTime: new Date('2026-09-21T00:00:00Z'),
        lastCheckTime: new Date('2026-09-20T16:00:00Z'),
      });
      expect(mapCompetitorAsinWrite(asin)).toEqual(await legacyRecord(asin));
    },
  );
});
