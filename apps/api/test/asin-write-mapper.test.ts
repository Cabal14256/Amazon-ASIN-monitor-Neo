import { asinRecordResultSchema } from '@asin-monitor/contracts';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { asinWriteResult } from '../src/asin/asin-write.service';
import {
  fixtureAt,
  queryAsin,
  queryGroup,
} from './helpers/asin-query-fixtures';

const filename = resolve(__dirname, '../../../server/src/models/ASIN.js');
const nativeRequire = createRequire(filename);
function raw(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
      typeof item === 'boolean' ? Number(item) : item,
    ]),
  );
}
describe('standalone ASIN write response / actual Legacy model', () => {
  it.each([false, true, null])(
    'matches all aliases and inherited metadata with own manual=%s',
    async (manualBroken) => {
      const group = queryGroup({
        manualBroken: true,
        manualBrokenReason: 'Parent exception',
        manualBrokenUpdatedAt: fixtureAt,
      });
      const asin = queryAsin({
        manualBroken,
        manualBrokenReason: 'Own exception',
        manualBrokenUpdatedAt: fixtureAt,
        manualExcludedFromGroup: manualBroken === false,
        manualExcludedReason: 'Group exclusion',
        manualExcludedUpdatedBy: 'fixture-actor',
        asinType: 'MAIN_LINK',
        createTime: null,
        feishuNotifyEnabled: null,
      });
      const row = {
        ...raw(asin),
        parent_manual_broken: 1,
        parent_manual_broken_reason: group.manualBrokenReason,
        parent_manual_broken_updated_at: group.manualBrokenUpdatedAt,
        parent_manual_broken_updated_by: group.manualBrokenUpdatedBy,
      };
      const module = {
        exports: {} as { findById(id: string): Promise<unknown> },
      };
      vm.runInNewContext(
        readFileSync(filename, 'utf8'),
        {
          module,
          exports: module.exports,
          require: (name: string) => {
            if (name === '../config/database')
              return { query: async () => [row] };
            if (name === '../utils/variantStatus') return nativeRequire(name);
            if (name === 'uuid') return { v4: () => 'fixture-unused-id' };
            if (name === './VariantGroup' || name === './MonitorHistory')
              return {};
            throw new Error('Unexpected Legacy fixture dependency');
          },
        },
        { filename },
      );
      const expected = JSON.parse(
        JSON.stringify(await module.exports.findById(asin.id)),
      );
      const actual = asinWriteResult({ asin, group });
      expect(actual).toEqual(expected);
      expect(actual).toMatchObject({
        parentId: group.id,
        variantGroupId: group.id,
      });
      asinRecordResultSchema.parse({
        success: true,
        errorCode: 0,
        data: actual,
      });
    },
  );
  it('rejects a mismatched parent snapshot instead of constructing misleading state', () => {
    expect(() =>
      asinWriteResult({
        asin: queryAsin(),
        group: queryGroup({ id: 'different' }),
      }),
    ).toThrow('Invalid ASIN write result');
  });
});
