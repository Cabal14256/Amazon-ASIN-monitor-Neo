import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/client';
import { DrizzleCompetitorWriteUnit } from '../src/repositories/competitor-write-unit';

function database(reads: Record<string, unknown>[][]) {
  const locks: string[] = [];
  const select = vi.fn(() => {
    const rows = reads.shift();
    if (!rows) throw new Error('Unexpected read');
    const query = {
      from: () => query,
      where: () => query,
      limit: () => query,
      orderBy: () => query,
      for: (mode: string) => {
        locks.push(mode);
        return query;
      },
      then: Promise.resolve(rows).then.bind(Promise.resolve(rows)),
    };
    return query;
  });
  const update = vi.fn(() => {
    throw new Error('Unexpected update');
  });
  const remove = vi.fn(() => ({ where: async () => undefined }));
  const db = { select, update, delete: remove } as unknown as Db;
  return {
    unit: new DrizzleCompetitorWriteUnit(db, () => undefined),
    select,
    update,
    remove,
    locks,
  };
}

describe('competitor confirmed mutation snapshots', () => {
  it('retains Legacy bodyless group deletion without imposing a child snapshot or response limit', async () => {
    const f = database([[{ id: 'g1' }]]);
    await f.unit.deleteGroup('g1');
    expect(f.locks).toEqual(['update']);
    expect(f.select).toHaveBeenCalledOnce();
    expect(f.remove).toHaveBeenCalledOnce();
  });

  it('treats an explicit empty child snapshot as a confirmation, not an omitted snapshot', async () => {
    const f = database([[{ id: 'g1' }], [{ id: 'new-child' }]]);
    await expect(f.unit.deleteGroup('g1', [])).rejects.toMatchObject({
      code: 'members-changed',
    });
    expect(f.locks).toEqual(['update', 'update']);
    expect(f.remove).not.toHaveBeenCalled();
  });

  it('deletes a group only after all supplied child IDs match under locks', async () => {
    const f = database([[{ id: 'g1' }], [{ id: 'a1' }, { id: 'a2' }]]);
    await f.unit.deleteGroup('g1', ['a2', 'a1']);
    expect(f.locks).toEqual(['update', 'update']);
    expect(f.remove).toHaveBeenCalledOnce();
  });

  it.each([
    { name: 'Concurrent rename' },
    { country: 'DE' },
    { brand: 'Concurrent brand' },
    { updateTime: new Date('2020-01-01T00:00:01.000Z') },
  ])(
    'rejects stale group deletion after locking even when children are unchanged: %j',
    async (changed) => {
      const expectedSource = {
        name: 'Confirmed group',
        country: 'US',
        brand: 'Confirmed brand',
        updateTime: '2020-01-01T00:00:00.000Z',
      };
      const f = database([
        [
          {
            id: 'g1',
            ...expectedSource,
            updateTime: new Date(expectedSource.updateTime),
            ...changed,
          },
        ],
      ]);
      await expect(
        f.unit.deleteGroup('g1', ['a1'], expectedSource),
      ).rejects.toMatchObject({ code: 'source-changed' });
      expect(f.locks).toEqual(['update']);
      expect(f.remove).not.toHaveBeenCalled();
    },
  );

  it('deletes only when both locked group source and children still match', async () => {
    const expectedSource = {
      name: 'Confirmed group',
      country: 'US',
      brand: 'Confirmed brand',
      updateTime: '2020-01-01T00:00:00.000Z',
    };
    const f = database([
      [
        {
          id: 'g1',
          ...expectedSource,
          updateTime: new Date(expectedSource.updateTime),
        },
      ],
      [{ id: 'a1' }],
    ]);
    await f.unit.deleteGroup('g1', ['a1'], expectedSource);
    expect(f.locks).toEqual(['update', 'update']);
    expect(f.remove).toHaveBeenCalledOnce();
  });

  it.each(['g2', 'g3'])(
    'rejects stale confirmed moves before writing even when target is %s',
    async (target) => {
      const current = { id: 'a1', variantGroupId: 'g2', country: 'US' };
      const f = database([
        [current],
        [{ id: target, country: 'US' }],
        [
          { id: 'g2', country: 'US' },
          { id: 'g3', country: 'US' },
        ],
        [current],
      ]);
      await expect(f.unit.moveAsin('a1', target, 'g1')).rejects.toMatchObject({
        code: 'source-changed',
      });
      expect(f.locks).toEqual(['update', 'update']);
      expect(f.update).not.toHaveBeenCalled();
    },
  );

  it('preserves a Legacy same-group move without requiring the new source field', async () => {
    const current = { id: 'a1', variantGroupId: 'g1', country: 'US' };
    const parent = { id: 'g1', country: 'US' };
    const f = database([[current], [parent], [parent], [current]]);
    await expect(f.unit.moveAsin('a1', 'g1')).resolves.toEqual(current);
    expect(f.update).not.toHaveBeenCalled();
  });

  it('rejects a move when the row obtained after locking no longer belongs to the candidate parent', async () => {
    const f = database([
      [{ id: 'a1', variantGroupId: 'g1', country: 'US' }],
      [{ id: 'g3', country: 'US' }],
      [
        { id: 'g1', country: 'US' },
        { id: 'g3', country: 'US' },
      ],
      [{ id: 'a1', variantGroupId: 'g2', country: 'US' }],
    ]);
    await expect(f.unit.moveAsin('a1', 'g3', 'g1')).rejects.toMatchObject({
      code: 'parent-changed',
    });
    expect(f.update).not.toHaveBeenCalled();
  });
});
