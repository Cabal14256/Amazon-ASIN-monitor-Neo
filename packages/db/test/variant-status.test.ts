import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  resolveAsinVariantStatus,
  resolveGroupVariantStatus,
} from '../src/domain/variant-status';

const filename = resolve(
  __dirname,
  '../../../server/src/utils/variantStatus.js',
);
const module = { exports: {} as Record<string, (...args: any[]) => any> };
vm.runInNewContext(
  readFileSync(filename, 'utf8'),
  { module, exports: module.exports, require: createRequire(filename) },
  { filename },
);
const legacy = module.exports;
const at = new Date('2026-09-07T00:00:00.000Z');
const variants = [false, true, null] as const;
const oldFlag = (value: boolean | null) =>
  value === null ? null : Number(value);
const own = {
  manualBrokenReason: 'Own reason',
  manualBrokenUpdatedAt: at,
  manualBrokenUpdatedBy: 'fixture-own',
};
const parent = {
  manualBrokenReason: 'Group reason',
  manualBrokenUpdatedAt: at,
  manualBrokenUpdatedBy: 'fixture-group',
};

describe('effective ASIN status / actual Legacy behavior', () => {
  for (const auto of variants)
    for (const self of variants)
      for (const inherited of variants)
        for (const excluded of variants) {
          it(`preserves auto=${auto}, self=${self}, parent=${inherited}, exclusion=${excluded}`, () => {
            const result = resolveAsinVariantStatus(
              {
                ...own,
                isBroken: auto,
                manualBroken: self,
                manualExcludedFromGroup: excluded,
                manualExcludedReason: 'Excluded',
                manualExcludedUpdatedAt: at,
                manualExcludedUpdatedBy: 'fixture-excluded',
              },
              { ...parent, manualBroken: inherited },
            );
            const expected = legacy.decorateAsinStatus(
              {
                is_broken: oldFlag(auto),
                manual_broken: oldFlag(self),
                manual_broken_reason: own.manualBrokenReason,
                manual_broken_updated_at: at,
                manual_broken_updated_by: own.manualBrokenUpdatedBy,
                manual_excluded_from_group: oldFlag(excluded),
                manual_excluded_reason: 'Excluded',
                manual_excluded_updated_at: at,
                manual_excluded_updated_by: 'fixture-excluded',
              },
              {
                parentManualBroken: oldFlag(inherited),
                parentManualBrokenReason: parent.manualBrokenReason,
                parentManualBrokenUpdatedAt: at,
                parentManualBrokenUpdatedBy: parent.manualBrokenUpdatedBy,
              },
            );
            expect(result).toEqual(
              Object.fromEntries(
                Object.keys(result).map((key) => [key, expected[key]]),
              ),
            );
          });
        }
  it('retains empty metadata as null and does not mutate source records', () => {
    const record = Object.freeze({
      manualBroken: true,
      manualBrokenReason: '',
      manualExcludedFromGroup: false,
      manualExcludedReason: 'Old excluded reason',
    });
    expect(resolveAsinVariantStatus(record)).toMatchObject({
      manualBrokenReason: null,
      manualExcludedReason: null,
      manualBrokenScope: 'SELF',
    });
    expect(record.manualExcludedReason).toBe('Old excluded reason');
  });
});

describe('effective group status / actual Legacy behavior', () => {
  for (const auto of variants)
    for (const manual of variants)
      for (const childAuto of variants)
        for (const childManual of variants) {
          it(`preserves own=${auto}/${manual}, child=${childAuto}/${childManual}`, () => {
            const children = [
              resolveAsinVariantStatus(
                { isBroken: childAuto, manualBroken: childManual },
                { manualBroken: manual },
              ),
            ];
            const result = resolveGroupVariantStatus(
              { ...parent, isBroken: auto, manualBroken: manual },
              children,
            );
            const expected = legacy.decorateVariantGroupStatus(
              {
                is_broken: oldFlag(auto),
                manual_broken: oldFlag(manual),
                manual_broken_reason: parent.manualBrokenReason,
                manual_broken_updated_at: at,
                manual_broken_updated_by: parent.manualBrokenUpdatedBy,
              },
              children,
            );
            expect(result).toEqual(
              Object.fromEntries(
                Object.keys(result).map((key) => [key, expected[key]]),
              ),
            );
          });
        }
  it('keeps the group manual marker separate from a child manual exception', () => {
    const child = resolveAsinVariantStatus({ manualBroken: true });
    expect(resolveGroupVariantStatus({}, [child])).toMatchObject({
      isBroken: 1,
      manualBroken: 0,
      statusSource: 'MANUAL',
    });
    expect(resolveGroupVariantStatus({})).toMatchObject({
      isBroken: 0,
      manualBroken: 0,
      statusSource: 'NORMAL',
    });
  });
});
