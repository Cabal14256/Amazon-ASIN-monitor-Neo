import type { PrimaryMonitorJob } from '@asin-monitor/contracts';
import type { TaskState } from '@asin-monitor/db';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { MonitorRunEvents, monitorTimestamp } from '../src/monitor-live-events';

const nativeRequire = createRequire(__filename);
const legacyDate = nativeRequire('../../../server/src/utils/dateTime.js');
const legacyModule = {
  exports: {} as {
    getASINCheckOutcome(
      result: unknown,
      child: unknown,
    ): { errorType: string | null; classificationErrorType: string | null };
    getASINClassificationKey(child: unknown): string;
  },
};
runInNewContext(
  readFileSync(
    resolve(
      __dirname,
      '../../../server/src/services/deferredASINRetryService.js',
    ),
    'utf8',
  ),
  {
    module: legacyModule,
    require: (name: string) => {
      if (name === './deferredASINPersistenceService') return {};
      if (name === '../utils/logger') return {};
      throw new Error('Unexpected Legacy outcome dependency');
    },
  },
);
const job: PrimaryMonitorJob = {
  taskId: 'fixture-252',
  userId: 'owner',
  taskType: 'monitor',
  taskSubType: 'primary',
  createdAt: '2026-10-11T00:00:00.000Z',
  expiresAt: '2026-10-18T00:00:00.000Z',
  countries: ['US'],
};
describe('Legacy monitor public field parity', () => {
  it.each(['"'.repeat(2048), '猫'.repeat(2048)])(
    'rejects escaped or multibyte summaries by encoded bytes',
    async (name) => {
      const publish = vi.fn(),
        events = new MonitorRunEvents(job, { publish });
      for (let i = 0; i < 200; i++)
        events.addGroup('US', {
          isBroken: true,
          groupSnapshot: {
            id: `g-${i}`,
            name,
            children: [],
            feishuNotifyEnabled: 0,
          },
          brokenByType: { SP_API_ERROR: 0, NOT_FOUND: 0, NO_VARIANTS: 0 },
        });
      expect(events.countryResults).toEqual({});
      await events.complete({} as TaskState);
      expect(publish).not.toHaveBeenCalled();
    },
  );
  it('keeps a full valid summary when a classification is overwritten and group counts grow through four digits', async () => {
    const publish = vi.fn(),
      events = new MonitorRunEvents(job, { publish }),
      id = 'g'.repeat(600);
    for (let i = 0; i < 1000; i++)
      events.addGroup('US', {
        isBroken: false,
        groupSnapshot: {
          id,
          name: '组',
          feishuNotifyEnabled: 0,
          children: [{ id: 'a', asin: 'B000000001', isBroken: 1 }],
        },
        details: {
          results: [
            {
              asin: 'B000000001',
              errorType: i % 2 ? 'NOT_FOUND' : 'SP_API_ERROR',
            },
          ],
        },
      });
    const summary = events.countryResults.US;
    expect(summary.totalGroups).toBe(1000);
    expect(summary.checkedGroupKeys).toHaveLength(1000);
    expect(summary.asinClassifications).toEqual({
      [`group:${id}:asin:a`]: 'NOT_FOUND',
    });
    await events.complete({} as TaskState);
    expect(publish).toHaveBeenCalledOnce();
    const complete = publish.mock.calls[0][2];
    expect(complete.countryResults).toEqual(events.countryResults);
    expect(complete.totalChecked).toBe(1000);
    expect(Buffer.byteLength(JSON.stringify(complete))).toBeLessThan(
      1024 * 1024,
    );
  });
  it('releases an oversized public summary and refuses the whole completion instead of truncating it', async () => {
    const publish = vi.fn(),
      events = new MonitorRunEvents(job, { publish });
    for (let i = 0; i < 1000; i++)
      events.addGroup('US', {
        isBroken: true,
        groupSnapshot: {
          id: `g-${i}`,
          name: 'n'.repeat(2048),
          children: [],
          feishuNotifyEnabled: 0,
        },
        brokenByType: { SP_API_ERROR: 0, NOT_FOUND: 0, NO_VARIANTS: 0 },
      });
    expect(events.countryResults).toEqual({});
    await events.complete({} as TaskState);
    expect(publish).not.toHaveBeenCalled();
  });
  it.each([
    '2026-10-11T16:00:00.000Z',
    '2026-12-31T23:59:59.999Z',
    '2026-10-11T00:00:00.001Z',
  ])('matches actual Legacy UTC8 formatter at %s', (date) => {
    expect(monitorTimestamp(new Date(date))).toBe(
      legacyDate.toUTC8ISOString(new Date(date)),
    );
  });
  it.each([0, 1])(
    'keeps exact manual fields and actual Legacy classifications with group notification=%i',
    (enabled) => {
      const child = {
        id: 'a-manual',
        asin: 'b000000001',
        name: '人工异常',
        brand: '牌',
        isBroken: 1,
        feishuNotifyEnabled: 1,
        statusSource: 'MANUAL',
        manualBroken: 1,
        manualBrokenReason: '原因',
        manualBrokenUpdatedAt: '2026-10-11T00:00:00.000Z',
        manualBrokenUpdatedBy: 'actor-id',
      };
      const automatic = {
        ...child,
        id: 'a-auto',
        asin: 'B000000002',
        statusSource: 'AUTO',
        manualBroken: 0,
      };
      const deferred = { ...automatic, id: 'a-deferred', asin: 'B000000003' };
      const input = {
        isBroken: true,
        brokenByType: { SP_API_ERROR: 1, NOT_FOUND: 0, NO_VARIANTS: 0 },
        groupSnapshot: {
          id: ' raw group ',
          name: '组名',
          statusSource: 'AUTO+MANUAL',
          manualBroken: 1,
          manualBrokenReason: '组原因',
          manualBrokenUpdatedAt: child.manualBrokenUpdatedAt,
          manualBrokenUpdatedBy: child.manualBrokenUpdatedBy,
          feishuNotifyEnabled: enabled,
          children: [child, automatic, deferred],
        },
        details: {
          results: [
            { asin: 'B000000001', hasVariants: true, variantCount: 1 },
            { asin: 'b000000002', errorType: 'SP_API_ERROR' },
            { asin: 'B000000003', isDeferred: true },
          ],
        },
        brokenASINs: [{ asin: 'B000000002', errorType: 'SP_API_ERROR' }],
      };
      const events = new MonitorRunEvents(job);
      events.addGroup('US', input);
      const summary = events.countryResults.US;
      const classifications = Object.fromEntries(
        [child, automatic, deferred].flatMap((row) => {
          const outcome = legacyModule.exports.getASINCheckOutcome(input, row);
          return outcome.classificationErrorType
            ? [
                [
                  legacyModule.exports.getASINClassificationKey({
                    ...row,
                    asinId: row.id,
                    variantGroupId: input.groupSnapshot.id,
                  }),
                  outcome.classificationErrorType,
                ],
              ]
            : [];
        }),
      );
      expect(summary.asinClassifications).toEqual(classifications);
      expect(summary.brokenGroupNames).toEqual(['组名']);
      expect(summary.brokenGroupDetails).toEqual([
        {
          variantGroupId: ' raw group ',
          groupName: '组名',
          statusSource: 'AUTO+MANUAL',
          manualBroken: 1,
          manualBrokenReason: '组原因',
          manualBrokenUpdatedAt: child.manualBrokenUpdatedAt,
          manualBrokenUpdatedBy: child.manualBrokenUpdatedBy,
        },
      ]);
      expect(summary.brokenASINs).toEqual(
        enabled
          ? [child, automatic, deferred].map((row) => ({
              asin: row.asin,
              asinId: row.id,
              name: row.name,
              variantGroupId: input.groupSnapshot.id,
              groupName: '组名',
              brand: row.brand,
              errorType: legacyModule.exports.getASINCheckOutcome(input, row)
                .errorType,
              statusSource: row.statusSource,
              manualBroken: row.manualBroken,
              manualBrokenReason: row.manualBrokenReason,
              manualBrokenUpdatedAt: row.manualBrokenUpdatedAt,
              manualBrokenUpdatedBy: row.manualBrokenUpdatedBy,
            }))
          : [],
      );
      expect(summary.checkedGroupKeys).toEqual(['group: raw group ']);
      expect(summary.brokenByType).toEqual(input.brokenByType);
    },
  );
});
