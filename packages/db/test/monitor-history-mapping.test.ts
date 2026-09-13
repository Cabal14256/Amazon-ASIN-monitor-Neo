import { monitorHistoryRecordSchema } from '@asin-monitor/contracts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  decodeMonitorHistorySelectedRow,
  mapMonitorHistoryRecord,
  monitorHistorySafeCount,
  type MonitorHistorySelectedRow,
} from '../src/domain/monitor-history-query';

const filename = resolve(
  __dirname,
  '../../../server/src/models/MonitorHistory.js',
);
const at = new Date('2026-09-12T16:30:12.123Z');
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
function fixture(
  overrides: Partial<MonitorHistorySelectedRow> = {},
): MonitorHistorySelectedRow {
  return {
    id: 107n,
    variant_group_id: null,
    asin_id: null,
    check_type: 'ASIN',
    country: 'UK',
    is_broken: true,
    check_time: at,
    check_result: '{"title":"完整快照","nested":{"items":[1,2]}}',
    notification_sent: false,
    create_time: at,
    variant_group_name: '已经删除的组',
    asin: 'B000000107',
    asin_name: '历史名称',
    asin_type: 'MAIN_LINK',
    ...overrides,
  };
}
const sqlFixture = () => ({
  ...fixture(),
  id: '107',
  check_time: '2026-09-13T00:30:12.123',
  create_time: '2026-09-13T00:30:12.123',
});
function legacy(row: MonitorHistorySelectedRow) {
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
      process: { env: {} },
      require: (name: string) => {
        if (name === '../config/database') return { query };
        if (name === '../utils/logger')
          return { debug() {}, info() {}, warn() {}, error() {} };
        if (
          [
            '../services/cacheService',
            '../services/analyticsCacheService',
            '../services/analyticsAggService',
          ].includes(name)
        )
          return {};
        throw new Error('Unexpected Legacy history fixture dependency');
      },
    },
    { filename },
  );
  return { model: module.exports, query };
}
describe('complete monitor history / actual Legacy model', () => {
  afterEach(() => vi.unstubAllEnvs());
  const combinations = [false, true, null].flatMap((is_broken) =>
    [false, true, null].flatMap((notification_sent) =>
      ['ASIN', 'GROUP', null].map((check_type) => ({
        is_broken,
        notification_sent,
        check_type,
      })),
    ),
  );
  it.each(combinations)(
    'preserves nullable history state $is_broken / $notification_sent / $check_type',
    async (overrides) => {
      const row = fixture({ ...overrides, create_time: null, asin_type: null });
      const f = legacy(row);
      const expected = json(await f.model.findById(Number(row.id)));
      const actual = mapMonitorHistoryRecord(row);
      expect(actual).toEqual(expected);
      expect(monitorHistoryRecordSchema.parse(actual)).toEqual(actual);
      expect(f.query).toHaveBeenCalledTimes(1);
    },
  );
  it('preserves complete nested result text and both aliases without parsing or truncation', async () => {
    const result = JSON.stringify({
      title: '完整结果'.repeat(100_000),
      nested: { a: [1, 2, null] },
    });
    const row = fixture({ check_result: result });
    const actual = mapMonitorHistoryRecord(row);
    expect(actual).toEqual(json(await legacy(row).model.findById(107)));
    expect(actual.check_result).toBe(result);
    expect(actual.checkResult).toBe(result);
    expect(actual.asinType).toBe('MAIN_LINK');
  });
  it.each(['UTC', 'Asia/Shanghai', 'America/New_York'])(
    'uses D8 wall time independently of host %s',
    (timezone) => {
      vi.stubEnv('TZ', timezone);
      const source = sqlFixture();
      expect(
        mapMonitorHistoryRecord(decodeMonitorHistorySelectedRow(source)),
      ).toEqual(mapMonitorHistoryRecord(fixture()));
    },
  );
  it.each([
    null,
    {},
    [],
    { ...sqlFixture(), id: '9007199254740993' },
    { ...sqlFixture(), check_time: 'infinity' },
    { ...sqlFixture(), check_time: null },
    { ...sqlFixture(), check_result: {} },
    { ...sqlFixture(), is_broken: 1 },
    { ...sqlFixture(), asin_name: undefined },
  ])('rejects malformed or unrepresentable SQL output case %#', (value) => {
    expect(() => decodeMonitorHistorySelectedRow(value)).toThrow();
  });
  it.each([
    null,
    undefined,
    true,
    '',
    '1e3',
    '0x10',
    '-1',
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    9007199254740993n,
  ])('rejects unsafe count %s', (value) => {
    expect(() => monitorHistorySafeCount(value)).toThrow();
  });
  it('retains exact safe integer bounds and rejects zero record IDs', () => {
    expect(monitorHistorySafeCount(0)).toBe(0);
    expect(monitorHistorySafeCount('9007199254740991')).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(() => mapMonitorHistoryRecord(fixture({ id: 0n }))).toThrow();
  });
});
