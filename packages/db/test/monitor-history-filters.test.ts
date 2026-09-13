import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  parseMonitorHistoryId,
  parseMonitorHistoryQuery,
  validateMonitorHistoryReadQuery,
} from '../src/domain/monitor-history-filters';

function legacyController() {
  const findAll = vi.fn(async (_query?: unknown) => ({
    list: [],
    total: 0,
    current: 1,
    pageSize: 10,
  }));
  const filename = resolve(
    __dirname,
    '../../../server/src/controllers/monitorController.js',
  );
  const exports = {} as {
    getMonitorHistory(req: unknown, res: unknown): Promise<void>;
  };
  vm.runInNewContext(
    readFileSync(filename, 'utf8'),
    {
      exports,
      require: (name: string) => {
        if (name === '../models/MonitorHistory') return { findAll };
        if (name === '../utils/logger')
          return { debug() {}, info() {}, warn() {}, error() {} };
        if (
          name === '../utils/analyticsBenchmark' ||
          name === '../services/analyticsViewService'
        )
          return {};
        throw new Error('Unexpected Legacy controller fixture dependency');
      },
    },
    { filename },
  );
  return { controller: exports, findAll };
}
describe('monitor history input / Legacy controller rules', () => {
  it.each([
    '',
    '   ',
    'B000001',
    ' B000001 ',
    'B000001,B000002',
    'B000001\nB000002 B000001',
    'B000001,B000001',
    ',,,',
  ])('matches actual Legacy multi-ASIN normalization for %s', async (asin) => {
    const f = legacyController();
    await f.controller.getMonitorHistory(
      { query: { asin } },
      { json: vi.fn() },
    );
    const passed = f.findAll.mock.calls[0][0] as { asin?: string | string[] };
    const result = parseMonitorHistoryQuery({ asin });
    expect(result.asin ?? '').toEqual(passed.asin);
    validateMonitorHistoryReadQuery(result);
  });
  it('preserves filter values, legacy type trimming, wildcard text and pagination', () => {
    const raw = {
      variantGroupId: 'g-107',
      asinId: 'a-107',
      variantGroupName: '%_Group',
      asinName: ' old name ',
      asinType: ' MAIN_LINK ',
      checkType: ' ASIN ',
      country: 'EU',
      isBroken: '1',
      current: '2',
      pageSize: '25',
      startTime: '2026-09-13 00:00:00',
      endTime: '2026-09-13 12:30:00.1',
    };
    const result = parseMonitorHistoryQuery(raw);
    expect(result).toEqual({
      ...raw,
      current: 2,
      pageSize: 25,
      asinType: 'MAIN_LINK',
      checkType: 'ASIN',
      isBroken: true,
      endTime: '2026-09-13 12:30:00.100',
    });
    validateMonitorHistoryReadQuery(result);
  });
  it.each(['0', 'true', 'false', 'yes', '01', '2'])(
    'retains Legacy supplied isBroken=%s false comparison',
    (value) => {
      expect(parseMonitorHistoryQuery({ isBroken: value }).isBroken).toBe(
        false,
      );
    },
  );
  it('keeps omitted/empty filters distinct from supplied false and expands midnight', () => {
    expect(
      parseMonitorHistoryQuery({
        current: '',
        pageSize: '',
        isBroken: '',
        asinType: ' ',
        startTime: '',
      }),
    ).toEqual({ current: 1, pageSize: 10 });
    expect(
      parseMonitorHistoryQuery({ startTime: '2024-02-29' }).startTime,
    ).toBe('2024-02-29 00:00:00');
  });
  it.each([
    null,
    [],
    { country: ['US', 'UK'] },
    { pageSize: '101' },
    { pageSize: '1.5' },
    { current: '-1' },
    { current: 'Infinity' },
    { current: '1000002', pageSize: '1' },
    { asinName: 'x'.repeat(501) },
    { variantGroupId: 'x'.repeat(51) },
    { asin: 'x'.repeat(201) },
    { country: 'US\0' },
    { startTime: '2023-02-29' },
    { startTime: '2026-04-31 00:00:00' },
    { startTime: '2026-01-01 24:00:00' },
    { startTime: '2026-01-01T00:00:00Z' },
    { startTime: '2026-01-01 00:60:00' },
    { startTime: '2026-01-01 00:00:00; SELECT 1' },
    { asin: Array.from({ length: 1001 }, (_, i) => `B${i}`).join(',') },
    { startTime: 'infinity' },
  ])('rejects invalid HTTP query case %#', (query) => {
    expect(() => parseMonitorHistoryQuery(query)).toThrow();
  });
  it.each([
    '0',
    '-1',
    '1.5',
    '1e3',
    '9007199254740992',
    '1 OR 1=1',
    '',
    ' 1',
    null,
  ])('rejects invalid ID %s', (id) => {
    expect(() => parseMonitorHistoryId(id)).toThrow();
  });
  it('accepts exact positive ID bounds without float rounding', () => {
    expect(parseMonitorHistoryId('000107')).toBe(107);
    expect(parseMonitorHistoryId('9007199254740991')).toBe(
      Number.MAX_SAFE_INTEGER,
    );
  });
  it.each([
    { current: 1, pageSize: 101 },
    { current: 1, pageSize: 10, asin: [] },
    { current: 1, pageSize: 10, asin: ['one'] },
    { current: 1, pageSize: 10, asin: ['one,two', 'three'] },
    { current: 1, pageSize: 10, isBroken: '1' },
    { current: 1, pageSize: 10, country: ['US'] },
  ])('validates typed repository input at runtime case %#', (query) => {
    expect(() => validateMonitorHistoryReadQuery(query as never)).toThrow();
  });
});
