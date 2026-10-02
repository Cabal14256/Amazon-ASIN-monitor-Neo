import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/client';
import { PgCompetitorTransactions } from '../src/repositories/competitor-transactions';
import { PgCompetitorWriteRepository } from '../src/repositories/competitor-write-repository';
import { DrizzleCompetitorWriteUnit } from '../src/repositories/competitor-write-unit';

function database(reads: Record<string, unknown>[][], allowWrites = false) {
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
    if (!allowWrites) throw new Error('Unexpected update');
    return { set: () => ({ where: async () => undefined }) };
  });
  const remove = vi.fn(() => ({ where: async () => undefined }));
  const values = vi.fn(async (_record: Record<string, unknown>) => undefined);
  const insert = vi.fn(() => {
    if (!allowWrites) throw new Error('Unexpected insert');
    return { values };
  });
  const execute = vi.fn(async () => ({
    rows: [{ triggers: 2, identity: true }],
  }));
  const db = {
    select,
    update,
    delete: remove,
    insert,
    execute,
  } as unknown as Db;
  return {
    db,
    unit: new DrizzleCompetitorWriteUnit(db, () => undefined),
    select,
    update,
    remove,
    insert,
    values,
    locks,
  };
}

afterEach(() => vi.restoreAllMocks());

/** Exercise the public repository wrapper, policy preparation and real write
 * unit. Only borrowed transaction plumbing and the database rows are fixtures. */
function repository(f: ReturnType<typeof database>) {
  vi.spyOn(PgCompetitorTransactions.prototype, 'run').mockImplementation(
    async (_readOnly, operation) =>
      operation({
        authorization: {
          lockOperator: async () => undefined,
          lockSession: async () => undefined,
          operatorPermissionCodes: async () => [],
        },
        database: async () => f.db,
        ensureOpen: () => undefined,
      }),
  );
  return new PgCompetitorWriteRepository({} as Pool, {} as Pool);
}

describe('competitor confirmed mutation snapshots', () => {
  it.each([
    { name: 'Concurrent rename' },
    { country: 'DE' },
    { brand: 'Concurrent brand' },
    { updateTime: new Date('2020-01-01T00:00:01.000Z') },
  ])(
    'retains the parent snapshot through the actual repository adapter: %j',
    async (changed) => {
      const expectedParent = {
        name: 'Confirmed group',
        country: 'US',
        brand: 'Confirmed brand',
        updateTime: '2020-01-01T00:00:00.000Z',
      };
      const f = database([
        [
          {
            id: 'g1',
            ...expectedParent,
            updateTime: new Date(expectedParent.updateTime),
            ...changed,
          },
        ],
      ]);
      const writer = repository(f);
      try {
        await expect(
          writer.transaction((unit) =>
            unit.createAsin(
              {
                asin: 'B000000121',
                name: null,
                country: 'US',
                brand: 'Own brand',
                asinType: null,
                parentId: 'g1',
              },
              expectedParent,
            ),
          ),
        ).rejects.toMatchObject({ code: 'source-changed' });
        expect(f.locks).toEqual(['update']);
        expect(f.select).toHaveBeenCalledOnce();
        expect(f.insert).not.toHaveBeenCalled();
        expect(f.update).not.toHaveBeenCalled();
      } finally {
        writer.close();
      }
    },
  );
  it.each([false, true])(
    'keeps compatible creation through the actual adapter with snapshot=%s',
    async (guarded) => {
      const expectedParent = {
        name: 'Confirmed group',
        country: 'US',
        brand: 'Confirmed brand',
        updateTime: '2020-01-01T00:00:00.000Z',
      };
      const fields = {
        asin: 'B000000121',
        name: null,
        country: 'US',
        brand: 'Own brand',
        asinType: null,
        parentId: 'g1',
      };
      const row = { id: 'a1', ...fields, variantGroupId: 'g1' };
      const f = database(
        [
          [
            {
              id: 'g1',
              ...expectedParent,
              updateTime: new Date(expectedParent.updateTime),
            },
          ],
          [],
          [row],
        ],
        true,
      );
      const writer = repository(f);
      try {
        await expect(
          writer.transaction((unit) =>
            unit.createAsin(fields, guarded ? expectedParent : undefined),
          ),
        ).resolves.toEqual(row);
        expect(f.insert).toHaveBeenCalledOnce();
        expect(f.locks).toEqual(['update']);
      } finally {
        writer.close();
      }
    },
  );
  it.each([false, true])(
    'creates with a matching optional parent snapshot (%s) while preserving Legacy omission',
    async (guarded) => {
      const expectedParent = {
        name: '\n ',
        country: 'US',
        brand: '',
        updateTime: '2020-01-01T00:00:00.000Z',
      };
      const fields = {
        asin: 'B000000121',
        name: null,
        country: 'US',
        brand: 'Own brand',
        asinType: null,
        parentId: 'g1',
      };
      const row = { id: 'a1', ...fields, variantGroupId: 'g1' };
      const f = database(
        [
          [
            {
              id: 'g1',
              ...expectedParent,
              updateTime: new Date(expectedParent.updateTime),
            },
          ],
          [],
          [row],
        ],
        true,
      );
      await expect(
        f.unit.createAsin(fields, guarded ? expectedParent : undefined),
      ).resolves.toEqual(row);
      expect(f.locks).toEqual(['update']);
      expect(f.insert).toHaveBeenCalledOnce();
      expect(f.values).toHaveBeenCalledWith(
        expect.objectContaining({ asin: fields.asin, variantGroupId: 'g1' }),
      );
      expect(f.values.mock.calls[0][0]).not.toHaveProperty('expectedParent');
      expect(f.values.mock.calls[0][0]).not.toHaveProperty('parentId');
      expect(f.update).toHaveBeenCalledOnce();
    },
  );
  it.each([
    { name: 'Concurrent rename' },
    { country: 'DE' },
    { brand: 'Concurrent brand' },
    { updateTime: new Date('2020-01-01T00:00:01.000Z') },
  ])(
    'rejects a stale create parent only after obtaining its lock: %j',
    async (changed) => {
      const expectedParent = {
        name: 'Confirmed group',
        country: 'US',
        brand: 'Confirmed brand',
        updateTime: '2020-01-01T00:00:00.000Z',
      };
      const f = database([
        [
          {
            id: 'g1',
            ...expectedParent,
            updateTime: new Date(expectedParent.updateTime),
            ...changed,
          },
        ],
      ]);
      await expect(
        f.unit.createAsin(
          {
            asin: 'B000000121',
            name: null,
            country: 'US',
            brand: 'Own brand',
            asinType: null,
            parentId: 'g1',
          },
          expectedParent,
        ),
      ).rejects.toMatchObject({ code: 'source-changed' });
      expect(f.locks).toEqual(['update']);
      expect(f.select).toHaveBeenCalledOnce();
      expect(f.insert).not.toHaveBeenCalled();
      expect(f.update).not.toHaveBeenCalled();
    },
  );
  it.each(['', ' ', '\n\t\r'])(
    'deletes an exactly matching persisted Legacy group %j under lock',
    async (oldText) => {
      const expectedSource = {
        name: oldText,
        country: oldText,
        brand: oldText,
        updateTime: null,
      };
      const f = database([[{ id: 'g1', ...expectedSource }], []]);
      await f.unit.deleteGroup('g1', [], expectedSource);
      expect(f.locks).toEqual(['update', 'update']);
      expect(f.remove).toHaveBeenCalledOnce();
    },
  );
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
