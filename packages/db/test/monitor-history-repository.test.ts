import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/client';
import { parseMonitorHistoryQuery } from '../src/domain/monitor-history-filters';
import {
  DrizzleMonitorHistoryQueryUnit,
  MAX_MONITOR_HISTORY_RESPONSE_BYTES,
} from '../src/repositories/monitor-history-query-repository';

function fixture(record: Record<string, unknown> = {}) {
  const row = {
    id: '107',
    variant_group_id: null,
    asin_id: null,
    check_type: 'ASIN',
    country: 'UK',
    is_broken: false,
    check_time: '2026-09-13T00:30:00',
    check_result: '{"full":true}',
    notification_sent: null,
    create_time: null,
    variant_group_name: 'deleted',
    asin: 'B000000107',
    asin_name: 'snapshot',
    asin_type: null,
    ...record,
  };
  const execute = vi.fn(async () => ({
    rows: [{ total: '1', bytes: '20000', records: [row] }],
  }));
  const db = createDb({ query: execute } as unknown as Pool);
  const ensureOpen = vi.fn();
  return {
    unit: new DrizzleMonitorHistoryQueryUnit(db, ensureOpen),
    execute,
    ensureOpen,
    row,
  };
}
describe('monitor history SQL and complete materialization', () => {
  it('binds attacker-controlled filters and uses one snapshot for selected keys/count/result', async () => {
    const f = fixture();
    const input = "' OR 1=1 --";
    const result = await f.unit.listHistory(
      parseMonitorHistoryQuery({
        variantGroupName: input,
        asin: 'B001,B002',
        country: 'EU',
        isBroken: '0',
        current: '3',
        pageSize: '4',
      }),
    );
    expect(f.execute).toHaveBeenCalledTimes(1);
    const [config, params] = f.execute.mock.calls[0] as unknown as [
      { text: string },
      unknown[],
    ];
    expect(config.text).not.toContain(input);
    expect(params).toContain(`%${input}%`);
    expect(params).toContain(4);
    expect(params).toContain(8);
    expect(config.text).toContain('WITH page_keys AS MATERIALIZED');
    expect(config.text).toContain('CASE WHEN size_bound.bytes::numeric');
    expect(config.text).toContain('mh.check_time DESC,mh.id DESC');
    expect(config.text).toContain(
      "rtrim(mh.country) COLLATE public.neo_import_group_ci IN ('UK','DE','FR','IT','ES')",
    );
    expect(result.list[0]).toMatchObject({
      id: 107,
      checkTime: '2026-09-12T16:30:00.000Z',
      checkResult: '{"full":true}',
      notificationSent: null,
    });
    expect(f.ensureOpen).toHaveBeenCalledTimes(2);
  });
  it('rejects an entire oversized result before reading records', async () => {
    const f = fixture();
    const records = vi.fn(() => {
      throw new Error('Oversized payload must not be read');
    });
    f.execute.mockResolvedValueOnce({
      rows: [
        {
          total: '1',
          bytes: String(MAX_MONITOR_HISTORY_RESPONSE_BYTES + 1),
          get records() {
            return records();
          },
        },
      ],
    });
    await expect(
      f.unit.listHistory({ current: 1, pageSize: 10 }),
    ).rejects.toMatchObject({ code: 'too-large' });
    expect(records).not.toHaveBeenCalled();
  });
  it('returns null for missing detail and rejects ambiguous composite IDs', async () => {
    const f = fixture();
    f.execute.mockResolvedValueOnce({
      rows: [{ total: '0', bytes: '0', records: [] }],
    });
    expect(await f.unit.historyById(107)).toBeNull();
    f.execute.mockResolvedValueOnce({
      rows: [{ total: '2', bytes: '40000', records: [f.row, f.row] }],
    });
    await expect(f.unit.historyById(107)).rejects.toMatchObject({
      code: 'invalid-result',
    });
  });
  it('checks current lifetime after SQL returns before materializing the response', async () => {
    const f = fixture();
    f.ensureOpen
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('Closed');
      });
    await expect(f.unit.historyById(107)).rejects.toThrow('Closed');
  });
});
