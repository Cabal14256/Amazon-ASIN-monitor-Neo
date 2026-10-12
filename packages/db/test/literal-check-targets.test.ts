import type { PrimaryMonitorJob } from '@asin-monitor/contracts';
import { getTableColumns } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/client';
import { PgCompetitorCheckRepository } from '../src/repositories/competitor-check-repository';
import { PgCompetitorTransactions } from '../src/repositories/competitor-transactions';
import { PgPrimaryMonitorRepository } from '../src/repositories/primary-monitor-repository';
import { DrizzleVariantCheckUnit } from '../src/repositories/variant-check-repository';
import { asins, variantGroups } from '../src/schema';
import {
  competitorAsins,
  competitorVariantGroups,
} from '../src/schema-competitor';

afterEach(() => vi.restoreAllMocks());
const unsafe = [
  '',
  'x'.repeat(51),
  '😺'.repeat(51),
  'a\u0000b',
  '\u001f',
  '\u007f',
  '\u0085',
  '\u009f',
  '\ud800',
  'a\udfff',
];

/** Real Drizzle SQL generation/mapping; only the PG wire transport is replaced.
 * Its old CI lookup simulation deliberately returns a sole normalized neighbour.
 * Actual MySQL/PG behaviour is covered independently by opt-in integration. */
function readFixture(
  domain: 'primary' | 'competitor',
  groupId: string,
  asinId: string,
) {
  const groupTable =
    domain === 'primary' ? variantGroups : competitorVariantGroups;
  const asinTable = domain === 'primary' ? asins : competitorAsins;
  const group = {
    ...Object.fromEntries(
      Object.values(getTableColumns(groupTable)).map((column) => [
        column.name,
        null,
      ]),
    ),
    id: groupId,
    name: 'Fixture',
    country: 'US',
    site: 'amazon.com',
    brand: 'Fixture',
    is_broken: false,
    variant_status: 'NORMAL',
    create_time: null,
    update_time: null,
  };
  const asin = {
    ...Object.fromEntries(
      Object.values(getTableColumns(asinTable)).map((column) => [
        column.name,
        null,
      ]),
    ),
    ...group,
    id: asinId,
    asin: 'B000000001',
    variant_group_id: groupId,
  };
  const fields = (table: PgTable, row: Record<string, unknown>) =>
    Object.values(getTableColumns(table)).map(
      (column) => row[column.name] ?? null,
    );
  const queries: { text: string; values: unknown[] }[] = [];
  const ci = (id: string) =>
    id
      .replace(/ +$/u, '')
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase();
  const query = vi.fn(
    async (
      config: { text: string; rowMode?: string },
      values: unknown[] = [],
    ) => {
      const text = config.text;
      queries.push({ text, values });
      const target = values[0];
      const matches = (id: string) =>
        typeof target === 'string' &&
        (/rtrim\(/i.test(text) ? ci(id) === ci(target) : id === target);
      if (text.includes('WITH selected'))
        return {
          rows: [
            {
              total: '0',
              total_asins: '0',
              groups: matches(groupId) ? [group] : [],
              asins: matches(groupId) ? [asin] : [],
            },
          ],
        };
      if (text.includes('from "asins"') && text.includes('inner join'))
        return {
          rows: matches(asinId)
            ? [[...fields(asinTable, asin), ...fields(groupTable, group)]]
            : [],
        };
      if (text.includes('from "competitor_variant_groups"'))
        return { rows: matches(groupId) ? [fields(groupTable, group)] : [] };
      if (text.includes('from "competitor_asins"')) {
        const childList = text.includes(
          'where "competitor_asins"."variant_group_id"',
        );
        return {
          rows: (childList ? target === groupId : matches(asinId))
            ? [fields(asinTable, asin)]
            : [],
        };
      }
      throw new Error('Unexpected fixture read');
    },
  );
  const db = drizzle({ query } as unknown as Pool) as Db;
  const primary = new DrizzleVariantCheckUnit(db, () => undefined);
  vi.spyOn(PgCompetitorTransactions.prototype, 'run').mockImplementation(
    async (_readOnly, action) =>
      action({
        authorization: {
          lockOperator: async () => undefined,
          lockSession: async () => undefined,
          operatorPermissionCodes: async () => [],
          competitorMonitorConfiguration: async () => undefined,
        },
        database: async () => db,
        ensureOpen: () => undefined,
      }),
  );
  const competitor = new PgCompetitorCheckRepository({} as Pool, {} as Pool);
  return {
    queries,
    read: (kind: 'group' | 'asin', id: string) =>
      domain === 'primary'
        ? kind === 'group'
          ? primary.loadGroup(id)
          : primary.loadSingle(id)
        : kind === 'group'
        ? competitor.transaction((unit) => unit.loadGroup(id))
        : competitor.transaction((unit) => unit.loadSingle(id)),
    close: () => competitor.close(),
  };
}

describe.each(['primary', 'competitor'] as const)(
  '%s check DB target boundary',
  (domain) => {
    describe.each(['group', 'asin'] as const)('%s target', (kind) => {
      it.each([' Leading Ś', 'Trailing Ś ', '   ', '😺'.repeat(50)])(
        'reads literal key %j without normalization',
        async (id) => {
          const f = readFixture(
            domain,
            kind === 'group' ? id : 'parent',
            kind === 'asin' ? id : 'child',
          );
          try {
            const snapshot = await f.read(kind, id);
            expect(
              kind === 'group'
                ? snapshot.group.id
                : 'asin' in snapshot && snapshot.asin.id,
            ).toBe(id);
            expect(f.queries[0].values[0]).toBe(id);
          } finally {
            f.close();
          }
        },
      );
      it.each(unsafe)(
        'rejects unsafe target %j before any SQL read',
        async (id) => {
          const f = readFixture(domain, 'parent', 'child');
          try {
            await expect(f.read(kind, id)).rejects.toMatchObject({
              code: 'invalid-input',
            });
            expect(f.queries).toEqual([]);
          } finally {
            f.close();
          }
        },
      );
    });
  },
);
describe.each(['group', 'asin'] as const)(
  'missing literal competitor %s',
  (kind) => {
    it.each([
      { stored: 'Tail', requested: 'Tail ' },
      { stored: 'Case', requested: 'case' },
      { stored: 'café', requested: 'cafe' },
    ])(
      'does not inspect the sole normalized neighbour %j',
      async ({ stored, requested }) => {
        const f = readFixture(
          'competitor',
          kind === 'group' ? stored : 'parent',
          kind === 'asin' ? stored : 'child',
        );
        try {
          await expect(f.read(kind, requested)).rejects.toMatchObject({
            code: kind === 'group' ? 'group-not-found' : 'asin-not-found',
          });
          expect(f.queries[0].values[0]).toBe(requested);
        } finally {
          f.close();
        }
      },
    );
  },
);

describe('primary monitor exact frozen ID replay', () => {
  const job: PrimaryMonitorJob = {
    taskId: '10000000-0000-4000-8000-000000000227',
    userId: 'fixture-owner',
    taskType: 'monitor',
    taskSubType: 'primary',
    createdAt: '2026-10-07T00:00:00.000Z',
    expiresAt: '2026-10-14T00:00:00.000Z',
    countries: ['US'],
  };
  it('first acceptance and retry preserve 50 astral codepoints and whitespace byte for byte', async () => {
    const groups = ['😺'.repeat(50), '   ', ' Leading Ś', 'Trailing Ś '].map(
      (groupId) => ({ groupId, country: 'US' }),
    );
    let saved: unknown;
    const query = vi.fn(async (text: string, values: unknown[] = []) => {
      if (text.includes('SELECT user_id'))
        return {
          rowCount: saved ? 1 : 0,
          rows: saved
            ? [
                {
                  user_id: job.userId,
                  task_created_at: job.createdAt,
                  countries: job.countries,
                  groups: saved,
                },
              ]
            : [],
        };
      if (text.includes('SELECT id, upper'))
        return {
          rows: groups.map((group) => ({
            id: group.groupId,
            country: group.country,
          })),
        };
      if (text.includes('INSERT INTO primary_monitor_runs'))
        saved = JSON.parse(String(values[4]));
      return { rows: [], rowCount: 0 };
    });
    const repository = new PgPrimaryMonitorRepository({
      connect: async () => ({ query, release() {} }),
    } as unknown as Pool);
    expect(await repository.groups(job)).toEqual(groups);
    expect(await repository.groups(job)).toEqual(groups);
    expect(
      query.mock.calls.filter(([text]) =>
        text.includes('INSERT INTO primary_monitor_runs'),
      ),
    ).toHaveLength(1);
  });
});
