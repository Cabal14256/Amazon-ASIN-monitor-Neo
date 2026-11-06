import { getTableColumns } from 'drizzle-orm';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/client';
import { DrizzleAsinQueryUnit } from '../src/repositories/asin-query-repository';
import { asins } from '../src/schema';

function child(groupId: string, id: string, time: string | null = null) {
  return {
    ...Object.fromEntries(
      Object.values(getTableColumns(asins)).map((column) => [
        column.name,
        null,
      ]),
    ),
    id,
    asin: 'B000000166',
    country: 'US',
    site: 'fixture',
    brand: 'fixture',
    variant_group_id: groupId,
    create_time: time,
    is_broken: false,
    export_cursor_time: time,
  };
}
function fixture(rows: Record<string, unknown>[] = []) {
  const query = vi.fn(async () => ({ rows }));
  const ensureOpen = vi.fn();
  const unit = new DrizzleAsinQueryUnit(
    createDb({ query } as unknown as Pool),
    ensureOpen,
  );
  return { unit, query, ensureOpen };
}

describe('ASIN export child batches over one ordered group page', () => {
  it('queries the supplied group order once, uses parameter binding and keeps native microseconds', async () => {
    const hostile = "g');DROP TABLE asins;--";
    const f = fixture([
      child(hostile, 'null'),
      child(hostile, 'time', '2026-09-27 09:00:00.123456'),
      child('a', 'tail'),
    ]);
    const result = await f.unit.listExportChildrenPage([hostile, 'empty', 'a']);
    expect(f.query).toHaveBeenCalledOnce();
    const command = f.query.mock.calls[0] as unknown as [
      { text: string },
      unknown[],
    ];
    expect(command[0].text).not.toContain(hostile);
    expect(command[0].text).toContain('selected.ordinal');
    expect(command[0].text).toContain('ASC NULLS FIRST');
    expect(command[0].text).toContain('COLLATE "C"');
    expect(command[0].text).not.toMatch(/\bOFFSET\b/i);
    expect(command[1]).toEqual([hostile, 0, 'empty', 1, 'a', 2, 5000]);
    expect(result.map((row) => row.variantGroupId)).toEqual([
      hostile,
      hostile,
      'a',
    ]);
    expect(result[1]!.exportCursorTime).toBe('2026-09-27 09:00:00.123456');
    expect(result[1]!.createTime?.toISOString()).toBe(
      '2026-09-27T01:00:00.123Z',
    );
  });

  it.each([null, '2026-09-27 09:00:00.123456'])(
    'binds a native continuation in the current group and then its later siblings (%s)',
    async (time) => {
      const f = fixture([child('a', 'after', time), child('later', 'tail')]);
      await f.unit.listExportChildrenPage(['earlier', 'a', 'later'], {
        groupId: 'a',
        id: 'A',
        createTime: time,
      });
      const [command, values] = f.query.mock.calls[0] as unknown as [
        { text: string },
        unknown[],
      ];
      expect(command.text).toContain('selected.ordinal>');
      expect(values).toContain(1);
      expect(values).toContain('A');
      if (time !== null) expect(values).toContain(time);
    },
  );

  it.each([
    { ids: [] },
    { ids: ['duplicate', 'duplicate'] },
    { ids: Array.from({ length: 51 }, (_, i) => `g${i}`) },
    { ids: ['bad\u0000id'] },
  ])(
    'rejects an invalid group-page identity without querying (%j)',
    async ({ ids }) => {
      const f = fixture();
      await expect(f.unit.listExportChildrenPage(ids)).rejects.toMatchObject({
        code: 'input',
      });
      expect(f.query).not.toHaveBeenCalled();
    },
  );
  it('rejects a continuation that belongs to another page without querying', async () => {
    const f = fixture();
    await expect(
      f.unit.listExportChildrenPage(['a'], {
        groupId: 'foreign',
        id: 'child',
        createTime: null,
      }),
    ).rejects.toMatchObject({ code: 'input' });
    expect(f.query).not.toHaveBeenCalled();
  });
  it.each([
    { rows: [child('foreign', 'x')] },
    { rows: [child('later', 'tail'), child('a', 'first')] },
    { rows: [child('a', 'same'), child('a', 'same')] },
    {
      rows: [
        child('a', 'time', '2026-09-27 09:00:00.123456'),
        child('a', 'null'),
      ],
    },
    { rows: [{ ...child('a', 'x'), export_cursor_time: undefined }] },
  ])(
    'refuses missing, repeated or out-of-order result identities (%j)',
    async ({ rows }) => {
      const f = fixture(rows);
      await expect(
        f.unit.listExportChildrenPage(['a', 'later']),
      ).rejects.toMatchObject({ code: 'result' });
    },
  );
  it('rechecks the snapshot after an awaited batch and never returns late records', async () => {
    const f = fixture([child('a', 'x')]);
    f.ensureOpen
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error('snapshot expired');
      });
    await expect(f.unit.listExportChildrenPage(['a'])).rejects.toThrow(
      'snapshot expired',
    );
  });
});
