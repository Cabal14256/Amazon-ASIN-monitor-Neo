import { ASIN_MANUAL_BROKEN_ACTIONS } from '@asin-monitor/contracts';
import {
  asinManualHistory,
  groupManualHistory,
  nextAsinManualState,
  type Asin,
  type NewMonitorHistory,
  type VariantGroup,
} from '@asin-monitor/db';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  fixtureAt,
  queryAsin,
  queryGroup,
} from './helpers/asin-query-fixtures';

const time = new Date('2026-09-08T00:00:00.000Z');
const actor = ' Fixture operator ';
const keys = [
  'manualBroken',
  'manualBrokenReason',
  'manualBrokenUpdatedAt',
  'manualBrokenUpdatedBy',
  'manualExcludedFromGroup',
  'manualExcludedReason',
  'manualExcludedUpdatedAt',
  'manualExcludedUpdatedBy',
] as const;
const snake = (key: string) =>
  key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
function raw(value: object): Record<string, any> {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      snake(key),
      typeof item === 'boolean' ? Number(item) : item,
    ]),
  );
}
function legacy(
  kind: 'ASIN' | 'VariantGroup',
  group: VariantGroup,
  children: Asin[],
) {
  const filename = resolve(__dirname, `../../../server/src/models/${kind}.js`);
  const nativeRequire = createRequire(filename);
  const groupRow = raw(group),
    rows = children.map(raw);
  const entries: Record<string, any>[] = [];
  const query = async (sql: string, params: any[] = []) => {
    if (sql.includes('UPDATE asins') && kind === 'ASIN') {
      keys.forEach((key, index) => {
        rows[0][snake(key)] = params[index];
      });
      return [];
    }
    if (sql.includes('UPDATE variant_groups')) {
      keys.slice(0, 4).forEach((key, index) => {
        groupRow[snake(key)] = params[index];
      });
      return [];
    }
    if (sql.includes('UPDATE asins') && kind === 'VariantGroup') {
      rows
        .filter((row) => row.manual_excluded_from_group === 1)
        .forEach((row) => {
          Object.assign(row, {
            manual_excluded_from_group: 0,
            manual_excluded_reason: null,
            manual_excluded_updated_at: null,
            manual_excluded_updated_by: null,
          });
        });
      return [];
    }
    if (sql.includes('SELECT name FROM variant_groups'))
      return [{ name: groupRow.name }];
    if (sql.includes('SELECT * FROM variant_groups'))
      return [structuredClone(groupRow)];
    if (sql.includes('FROM asins'))
      return structuredClone(
        rows.map((row) => ({
          ...row,
          parent_manual_broken: groupRow.manual_broken,
          parent_manual_broken_reason: groupRow.manual_broken_reason,
          parent_manual_broken_updated_at: groupRow.manual_broken_updated_at,
          parent_manual_broken_updated_by: groupRow.manual_broken_updated_by,
        })),
      );
    throw new Error('Unexpected Legacy manual fixture query');
  };
  const module = {
    exports: {} as Record<string, (...args: any[]) => Promise<any>>,
  };
  vm.runInNewContext(
    readFileSync(filename, 'utf8'),
    {
      module,
      exports: module.exports,
      Date: class extends Date {
        constructor() {
          super(time);
        }
      },
      require: (name: string) => {
        if (name === '../config/database') return { query };
        if (name === '../utils/variantStatus') return nativeRequire(name);
        if (name === './MonitorHistory')
          return {
            create: async (entry: Record<string, any>) => entries.push(entry),
            bulkCreate: async (items: Record<string, any>[]) =>
              entries.push(...items),
          };
        if (name === './VariantGroup')
          return { updateTimeOnASINChange: async () => {}, clearCache() {} };
        if (name === '../services/cacheService')
          return { deleteByPrefix() {}, deleteByPrefixAsync: async () => {} };
        if (name === '../utils/logger') return {};
        if (name === 'uuid') return { v4: () => 'unused-fixture' };
        throw new Error('Unexpected Legacy manual dependency');
      },
    },
    { filename },
  );
  return { model: module.exports, entries, rows, groupRow };
}
function historyJson(entries: (NewMonitorHistory | Record<string, any>)[]) {
  const columns = [
    'variantGroupId',
    'variantGroupName',
    'asinId',
    'asinCode',
    'asinName',
    'siteSnapshot',
    'brandSnapshot',
    'checkType',
    'country',
    'checkTime',
    'checkResult',
  ];
  return JSON.parse(
    JSON.stringify(
      entries.map((entry) => ({
        ...Object.fromEntries(
          columns.map((key) => [
            key,
            (entry as Record<string, any>)[key] || null,
          ]),
        ),
        isBroken: entry.isBroken ? 1 : 0,
      })),
    ),
  );
}
describe('manual state and complete history / actual Legacy model execution', () => {
  for (const action of ASIN_MANUAL_BROKEN_ACTIONS)
    for (const self of [false, true])
      for (const inherited of [false, true])
        for (const excluded of [false, true]) {
          it(`${action} self=${self} inherited=${inherited} excluded=${excluded}`, async () => {
            const group = queryGroup({
              manualBroken: inherited,
              manualBrokenReason: 'Parent reason',
              manualBrokenUpdatedAt: fixtureAt,
              manualBrokenUpdatedBy: 'parent-actor',
            });
            const previous = queryAsin({
              manualBroken: self,
              isBroken: excluded,
              manualBrokenReason: 'Own reason',
              manualBrokenUpdatedAt: fixtureAt,
              manualBrokenUpdatedBy: 'own-actor',
              manualExcludedFromGroup: excluded,
              manualExcludedReason: 'Excluded reason',
              manualExcludedUpdatedAt: fixtureAt,
              manualExcludedUpdatedBy: 'exclusion-actor',
            });
            const fields = {
              action,
              reason: action.startsWith('CLEAR') ? '' : 'New reason',
            };
            const f = legacy('ASIN', group, [previous]);
            await f.model.updateManualBrokenAction(previous.id, {
              ...fields,
              updatedBy: actor,
            });
            const next = nextAsinManualState(previous, fields, time, actor);
            expect(raw(next)).toEqual(
              Object.fromEntries(
                keys.map((key) => [snake(key), f.rows[0][snake(key)]]),
              ),
            );
            expect(
              historyJson([
                asinManualHistory(
                  previous,
                  { ...previous, ...next },
                  group,
                  fields,
                  time,
                  actor,
                ),
              ]),
            ).toEqual(historyJson(f.entries));
          });
        }
  for (const markedBroken of [false, true])
    for (const parentMarked of [false, true]) {
      it(`group marked=${markedBroken} previous=${parentMarked} includes every child history`, async () => {
        const group = queryGroup({
          manualBroken: parentMarked,
          manualBrokenReason: 'Old parent reason',
          manualBrokenUpdatedAt: fixtureAt,
          manualBrokenUpdatedBy: 'parent-actor',
        });
        const children = [
          queryAsin({ id: 'normal' }),
          queryAsin({ id: 'auto', isBroken: true }),
          queryAsin({
            id: 'self',
            manualBroken: true,
            manualBrokenReason: 'Self reason',
          }),
          queryAsin({
            id: 'excluded',
            manualExcludedFromGroup: true,
            manualExcludedReason: 'Exclusion reason',
            manualExcludedUpdatedAt: fixtureAt,
          }),
          queryAsin({
            id: 'inactive',
            manualExcludedFromGroup: null,
            manualExcludedReason: 'Historical exclusion',
          }),
        ];
        const fields = { markedBroken, reason: 'New group reason' };
        const f = legacy('VariantGroup', group, children);
        await f.model.updateManualBroken(
          group.id,
          markedBroken,
          fields.reason,
          actor,
        );
        const newGroup = {
          ...group,
          manualBroken: markedBroken,
          manualBrokenReason: markedBroken ? fields.reason : null,
          manualBrokenUpdatedAt: markedBroken ? time : null,
          manualBrokenUpdatedBy: markedBroken ? actor.trim() : null,
        };
        const newChildren = children.map((row) =>
          !markedBroken && row.manualExcludedFromGroup === true
            ? {
                ...row,
                manualExcludedFromGroup: false,
                manualExcludedReason: null,
                manualExcludedUpdatedAt: null,
                manualExcludedUpdatedBy: null,
              }
            : row,
        );
        const before = {
          groups: [group],
          asins: children,
          total: 1,
          totalASINs: children.length,
        };
        const after = { ...before, groups: [newGroup], asins: newChildren };
        expect(
          historyJson([
            ...groupManualHistory(before, after, fields, time, actor),
          ]),
        ).toEqual(historyJson(f.entries));
        expect(f.entries).toHaveLength(6);
        expect(
          newChildren.map((row) => raw(row).manual_excluded_reason),
        ).toEqual(f.rows.map((row) => row.manual_excluded_reason));
      });
    }
});
