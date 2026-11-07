import { drizzle } from 'drizzle-orm/node-postgres';
import { describe, expect, it, vi } from 'vitest';
import { CompetitorExportUnit } from '../src/repositories/competitor-export-repository';

describe('competitor export PostgreSQL query shape and admission', () => {
  function fixture() {
    const query = vi.fn(async () => ({ rows: [] }));
    const client = { query };
    const db = drizzle(client as never);
    const unit = new CompetitorExportUnit(db, () => undefined);
    return { unit, query };
  }
  it('keeps Legacy matching filters and literal child export status with native keyset bounds', async () => {
    const f = fixture();
    await f.unit.listExportGroups(
      {
        current: 1,
        pageSize: 50,
        keyword: 'é_%',
        country: 'us',
        variantStatus: 'BROKEN',
      },
      { id: 'padded ', createTime: '2026-09-27 00:00:00.123456' },
    );
    const text = JSON.stringify(f.query.mock.calls);
    expect(text).toContain('neo_competitor_query_like');
    expect(text).toContain('neo_competitor_query_ci');
    expect(text).toContain('DESC NULLS LAST');
    expect(text).toContain('COLLATE \\"C\\"');
    expect(text).not.toContain('"asins"');
    expect(text).not.toContain(' OFFSET ');
  });
  it('pages bounded children by requested group order and exact parent identity', async () => {
    const f = fixture();
    await f.unit.listExportChildrenPage([' g ', 'g'], {
      groupId: ' g ',
      id: 'a1',
      createTime: null,
    });
    const text = JSON.stringify(f.query.mock.calls);
    expect(text).toContain('selected.ordinal');
    expect(text).toContain('ASC NULLS FIRST');
    expect(text).toContain('export_group_id');
    expect(text).toContain('5000');
    expect(text).not.toContain('neo_competitor_query_ci');
  });
  it.each([
    { ids: [] },
    { ids: Array(51).fill('x') },
    { ids: ['x', 'x'] },
    { ids: ['bad\n'] },
  ])('rejects invalid child sets before SQL', async ({ ids }) => {
    const f = fixture();
    await expect(f.unit.listExportChildrenPage(ids)).rejects.toMatchObject({
      code: 'input',
    });
    expect(f.query).not.toHaveBeenCalled();
  });
});
