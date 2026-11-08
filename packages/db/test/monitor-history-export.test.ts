import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it, vi } from 'vitest';
import { DrizzleMonitorHistoryExportUnit } from '../src/repositories/monitor-history-export-repository';

const row = (id = '9223372036854775807') => ({
  id,
  export_cursor_time: '2026-09-27 00:00:00.123456',
  check_type: 'GROUP',
  country: 'US',
  is_broken: true,
  variant_group_name: '=literal',
  asin: null,
  asin_name: null,
  asin_type: null,
  check_result: '{"reason":"fixture"}',
});
function fixture(records: unknown[] = [row()], bytes = '100') {
  const query = vi.fn(async () => ({ rows: [{ records, bytes }] }));
  return {
    query,
    unit: new DrizzleMonitorHistoryExportUnit(
      drizzle({ query } as never),
      () => undefined,
    ),
  };
}
describe('native bounded history export keysets and row mapping', () => {
  it('preserves full bigint identity, microseconds and complete source fields without API JSON pagination', async () => {
    const f = fixture();
    const result = await f.unit.page({
      country: 'EU',
      startTime: '2026-09-01',
      endTime: '2026-09-28 00:00:00',
    });
    expect(result[0]).toEqual({
      cursor: {
        id: '9223372036854775807',
        checkTime: '2026-09-27 00:00:00.123456',
      },
      record: {
        checkTime: '2026-09-27 00:00:00',
        checkType: 'GROUP',
        country: 'US',
        isBroken: 1,
        variantGroupName: '=literal',
        asin: null,
        asinName: null,
        asinType: null,
        checkResult: '{"reason":"fixture"}',
      },
    });
    const sql = JSON.stringify(f.query.mock.calls);
    expect(sql).toContain('page_keys');
    expect(sql).toContain('size_bound');
    expect(sql).toContain('neo_import_group_ci');
    expect(sql).toContain('DESC');
    expect(sql).toContain('500');
    expect(sql).not.toContain('OFFSET');
    expect(sql).not.toContain('count(*)');
  });
  it.each([
    { id: '0', checkTime: '2026-09-27 00:00:00' },
    { id: '9223372036854775808', checkTime: '2026-09-27 00:00:00' },
    { id: '1', checkTime: '2026-02-30 00:00:00' },
    { id: '1', checkTime: '2026-09-27T00:00:00Z' },
  ])('rejects invalid cursors before touching PostgreSQL', async (cursor) => {
    const f = fixture();
    await expect(
      f.unit.page({ endTime: '2026-09-28' }, cursor),
    ).rejects.toMatchObject({ code: 'input' });
    expect(f.query).not.toHaveBeenCalled();
  });
  it('rejects an unfrozen end time and over-budget measurements', async () => {
    const f = fixture();
    await expect(f.unit.page({})).rejects.toMatchObject({ code: 'input' });
    expect(f.query).not.toHaveBeenCalled();
    await expect(
      fixture([], String(16 * 1024 * 1024 + 1)).unit.page({
        endTime: '2026-09-28',
      }),
    ).rejects.toMatchObject({ code: 'too-large' });
  });
  it('fails instead of repeating rows when a returned keyset regresses', async () => {
    const f = fixture([row('1'), row('2')]);
    await expect(f.unit.page({ endTime: '2026-09-28' })).rejects.toMatchObject({
      code: 'invalid-result',
    });
  });
});
