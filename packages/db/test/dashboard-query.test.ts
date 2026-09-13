import { dashboardDataSchema } from '@asin-monitor/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  dashboardDayStart,
  DashboardQueryError,
  mapDashboardData,
} from '../src/domain/dashboard-query';
import { formatShanghaiTimestamp } from '../src/timestamps';
import {
  legacyDashboard,
  type DashboardLegacyRows,
} from './helpers/dashboard-legacy';

function empty(): DashboardLegacyRows {
  return [
    [
      {
        totalGroups: 0,
        totalASINs: 0,
        brokenGroups: 0,
        brokenASINs: 0,
        todayChecks: 0,
        todayBroken: 0,
      },
    ],
    [],
    [],
    [],
    [],
    [],
    [],
  ];
}
function source(rows: DashboardLegacyRows) {
  const copy = rows.map((list) =>
    list.map((record) =>
      Object.fromEntries(
        Object.entries(record).map(([key, value]) => [
          key,
          value instanceof Date
            ? formatShanghaiTimestamp(value)
            : (key === 'is_broken' || key === 'notification_sent') &&
              value !== null
            ? value === 1
            : value,
        ]),
      ),
    ),
  );
  for (const key of Object.keys(copy[0][0]))
    copy[0][0][key] = String(copy[0][0][key]);
  for (const index of [4, 5, 6])
    for (const row of copy[index]) row.total = String(row.total);
  return {
    overview: copy[0][0],
    brokenGroups: copy[1],
    brokenASINs: copy[2],
    recentActivities: copy[3],
    groupsByCountry: copy[4],
    asinsByCountry: copy[5],
    todayByCountry: copy[6],
  };
}
async function compare(
  rows: DashboardLegacyRows,
  instant = '2026-09-13T16:00:00Z',
) {
  let index = 0;
  const calls: { statement: string; params?: unknown[] }[] = [];
  const legacy = await legacyDashboard(async (statement, params) => {
    calls.push({ statement, params });
    return rows[index++];
  }, Date.parse(instant));
  const actual = mapDashboardData(source(rows));
  expect(legacy.statusCode).toBe(200);
  expect(index).toBe(7);
  expect({ success: true, data: actual, errorCode: 0 }).toEqual(legacy.body);
  expect(dashboardDataSchema.parse(actual)).toEqual(actual);
  return { actual, calls };
}
describe('dashboard mapping / complete actual Legacy controller result', () => {
  it('matches the complete empty response and UTC+8 midnight query parameters', async () => {
    const { actual, calls } = await compare(empty());
    expect(actual.overview.overviewByCountry.EU_TOTAL.totalGroups).toBe(0);
    expect(calls[0].params).toEqual([
      '2026-09-14 00:00:00',
      '2026-09-14 00:00:00',
    ]);
    expect(calls[6].params).toEqual(['2026-09-14 00:00:00']);
    expect(dashboardDayStart(new Date('2026-09-13T15:59:59.999Z'))).toBe(
      '2026-09-13 00:00:00',
    );
    expect(dashboardDayStart(new Date('2026-09-13T16:00:00Z'))).toBe(
      '2026-09-14 00:00:00',
    );
  });
  it('preserves all country counters, EU totals and decimal SUM strings', async () => {
    const rows = empty();
    for (const [i, country] of [
      'US',
      'UK',
      'DE',
      'FR',
      'IT',
      'ES',
      'JP',
    ].entries()) {
      rows[4].push({ country, total: i + 1, broken: String(i) });
      rows[5].push({ country, total: 2 * (i + 1), broken: String(i + 1) });
      rows[6].push({ country, total: 3 * (i + 1), broken: String(i) });
    }
    rows[0][0] = {
      totalGroups: 28,
      totalASINs: 56,
      brokenGroups: 21,
      brokenASINs: 28,
      todayChecks: 84,
      todayBroken: 21,
    };
    const { actual } = await compare(rows);
    expect(actual.distribution.byCountry[0].broken).toBe('0');
    expect(actual.overview.overviewByCountry.EU_TOTAL).toMatchObject({
      totalGroups: 20,
      totalASINs: 40,
      brokenGroups: 15,
    });
    expect(actual.overview.overviewByCountry).not.toHaveProperty('JP');
  });
  it('preserves Legacy case-sensitive country lookup after the SQL grouping phase', async () => {
    const rows = empty();
    rows[0][0] = {
      totalGroups: 2,
      totalASINs: 0,
      brokenGroups: 1,
      brokenASINs: 0,
      todayChecks: 0,
      todayBroken: 0,
    };
    rows[4] = [
      { country: 'us ', total: 1, broken: '0' },
      { country: '日本', total: 1, broken: '1' },
    ];
    const { actual } = await compare(rows);
    expect(actual.overview.overviewByCountry.US.totalGroups).toBe(0);
  });
  it.each([null, 0, 1])(
    'retains full activity columns and nullable state %s with live names',
    async (state) => {
      const rows = empty();
      const time = new Date('2026-09-13T00:05:06Z');
      rows[3] = [
        {
          id: 113,
          variant_group_id: 'group',
          variant_group_name: 'Live group',
          asin_id: 'asin',
          asin_code: 'SNAPSHOT',
          asin_name: state === null ? null : 'Live product',
          site_snapshot: 'Old site',
          brand_snapshot: '',
          check_type: state === null ? null : 'ASIN',
          country: 'US',
          is_broken: state,
          check_time: time,
          hour_ts: new Date('2026-09-13T00:00:00Z'),
          day_ts: new Date('2026-09-12T16:00:00Z'),
          month_ts: new Date('2026-08-31T16:00:00Z'),
          check_result:
            state === null ? null : '{"text":"完整😀","nested":[1,true,null]}',
          notification_sent: state,
          create_time: state === null ? null : time,
          asin: state === null ? null : 'CURRENT',
        },
      ];
      const { actual } = await compare(rows);
      expect(actual.recentActivities[0].checkTime).toBe(
        '2026-09-13T00:05:06.000Z',
      );
      expect(actual.recentActivities[0]).not.toHaveProperty('checkResult');
      expect(actual.recentActivities[0]).not.toHaveProperty('asinType');
      expect(actual.recentActivities[0].asin_code).toBe('SNAPSHOT');
    },
  );
  it('retains stored alert status, original fields and NULL dates', async () => {
    const rows = empty();
    rows[1] = [
      {
        id: 'g',
        name: '人工组',
        country: 'UK',
        site: 'Site',
        brand: 'Brand',
        variant_status: 'NORMAL',
        update_time: null,
      },
    ];
    rows[2] = [
      {
        id: 'a',
        asin: 'B000000113',
        name: null,
        country: 'UK',
        site: 'Site',
        brand: 'Brand',
        variant_status: null,
        update_time: new Date('2026-09-13T02:03:04Z'),
        variant_group_name: '人工组',
      },
    ];
    const { actual } = await compare(rows);
    expect(actual.realtimeAlerts.brokenGroups[0].variant_status).toBe('NORMAL');
  });
  it('propagates the transaction deadline while mapping', () => {
    const data = source(empty());
    data.groupsByCountry = [{ country: 'US', total: '1', broken: '0' }];
    const ensureOpen = vi.fn(() => {
      throw new Error('fixture deadline');
    });
    expect(() => mapDashboardData(data, ensureOpen)).toThrow(
      'fixture deadline',
    );
  });
  it.each([undefined, null, -1, '1.1', '9007199254740992', NaN, Infinity])(
    'rejects invalid/unsafe counts %s',
    (value) => {
      const data = source(empty());
      data.overview.totalGroups = value;
      expect(() => mapDashboardData(data)).toThrow(DashboardQueryError);
    },
  );
  it('rejects incomplete results and oversized fixed lists instead of truncating', () => {
    expect(() => mapDashboardData({})).toThrow(DashboardQueryError);
    const data = source(empty());
    data.brokenGroups = new Array(11).fill({});
    expect(() => mapDashboardData(data)).toThrow(DashboardQueryError);
    expect(() => dashboardDayStart(new Date(NaN))).toThrow(DashboardQueryError);
  });
});
