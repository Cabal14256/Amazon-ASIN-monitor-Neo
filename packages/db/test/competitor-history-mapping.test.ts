import { competitorMonitorHistoryRecordSchema } from '@asin-monitor/contracts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { parseCompetitorHistoryQuery } from '../src/domain/competitor-history-filters';
import {
  decodeCompetitorHistoryRow,
  mapCompetitorHistoryRecord,
  type CompetitorHistorySelectedRow,
} from '../src/domain/competitor-history-query';

const filename = resolve(
  __dirname,
  '../../../server/src/models/CompetitorMonitorHistory.js',
);
const at = new Date('2026-09-12T16:30:12.123Z');
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
const fixture = (
  patch: Partial<CompetitorHistorySelectedRow> = {},
): CompetitorHistorySelectedRow => ({
  id: 131n,
  variant_group_id: 'group-131',
  variant_group_name: '历史组',
  asin_id: 'asin-131',
  asin_code: 'B000000131',
  asin_name: '历史商品',
  check_type: 'ASIN',
  country: 'US',
  is_broken: true,
  check_time: at,
  check_result: '{"details":{"parentAsin":"b000000001"}}',
  notification_sent: false,
  create_time: at,
  asin: 'B000000131',
  parent_asin: 'B000000002',
  ...patch,
});
function legacy(row: CompetitorHistorySelectedRow) {
  const query = vi.fn(async () => [
    {
      ...row,
      id: Number(row.id),
      is_broken: row.is_broken === null ? null : Number(row.is_broken),
      notification_sent:
        row.notification_sent === null ? null : Number(row.notification_sent),
    },
  ]);
  const module = { exports: {} as { findById(id: number): Promise<unknown> } };
  vm.runInNewContext(
    readFileSync(filename, 'utf8'),
    {
      module,
      exports: module.exports,
      require: (name: string) => {
        if (name === '../config/competitor-database') return { query };
        if (name === '../services/cacheService') return {};
        if (name === '../utils/logger')
          return { debug() {}, info() {}, warn() {}, error() {} };
        throw new Error('Unexpected Legacy competitor history dependency');
      },
    },
    { filename },
  );
  return module.exports;
}

describe('competitor history / actual Legacy model and bounded filters', () => {
  it.each(
    [false, true, null].flatMap((is_broken) =>
      [false, true, null].map((notification_sent) => ({
        is_broken,
        notification_sent,
      })),
    ),
  )(
    'keeps complete nullable state $is_broken / $notification_sent',
    async (patch) => {
      const row = fixture({ ...patch, create_time: null });
      const actual = mapCompetitorHistoryRecord(row);
      expect(actual).toEqual(json(await legacy(row).findById(131)));
      expect(competitorMonitorHistoryRecordSchema.parse(actual)).toEqual(
        actual,
      );
    },
  );
  it.each([
    '{"parentAsin":" b000000003 "}',
    '{"result":{"details":{"parentAsin":"b000000004"}}}',
    '"{\\"parentAsin\\":\\"b000000005\\"}"',
    'malformed',
    null,
  ])(
    'matches Legacy parent extraction and group fallback for %s',
    async (check_result) => {
      const row = fixture({ check_result });
      expect(mapCompetitorHistoryRecord(row)).toEqual(
        json(await legacy(row).findById(131)),
      );
    },
  );
  it.each(['UTC', 'Asia/Shanghai', 'America/New_York'])(
    'decodes the D8 timestamp independently of host %s',
    (zone) => {
      vi.stubEnv('TZ', zone);
      try {
        const raw = {
          ...fixture(),
          id: '131',
          check_time: '2026-09-13T00:30:12.123',
          create_time: '2026-09-13T00:30:12.123',
        };
        expect(
          mapCompetitorHistoryRecord(decodeCompetitorHistoryRow(raw)),
        ).toEqual(mapCompetitorHistoryRecord(fixture()));
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
  it('keeps a single ASIN LIKE pattern and Legacy false-value filter', () => {
    expect(
      parseCompetitorHistoryQuery({ asin: 'B000%,_1', isBroken: 'other' }),
    ).toMatchObject({
      asin: 'B000%,_1',
      isBroken: false,
      current: 1,
      pageSize: 10,
    });
    expect(() => parseCompetitorHistoryQuery({ pageSize: '101' })).toThrow();
    expect(() =>
      parseCompetitorHistoryQuery({ startTime: 'not-a-date' }),
    ).toThrow();
  });
});
