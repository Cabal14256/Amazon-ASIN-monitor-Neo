import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import {
  homeWorkbenchFixture,
  workbenchDays,
  workbenchInstant,
} from '../../contracts/test/helpers/home-workbench';
import type { Db } from '../src/client';
import {
  homeWorkbenchDays,
  HomeWorkbenchQueryError,
  mapHomeWorkbenchData,
  parseHomeWorkbenchQuery,
} from '../src/domain/home-workbench-query';
import { DrizzleHomeWorkbenchQueryUnit } from '../src/repositories/home-workbench-query-repository';

function raw(grant = true) {
  const data = homeWorkbenchFixture(grant),
    row = data.list[0];
  return {
    total: '1',
    list: [
      {
        id: row.id,
        name: row.name,
        country: row.country,
        site: row.site,
        brand: row.brand,
        broken: row.isBroken,
        asin_count: '2',
        last_check_time: '2026-10-06 23:59:59.999',
        trend:
          row.trend?.map((point) => ({
            day: point.day,
            checks: String(point.checks),
            broken_checks: String(point.brokenChecks),
            unknown_checks: String(point.unknownChecks),
          })) ?? null,
      },
    ],
    facets: [
      {
        country: row.country,
        site: row.site,
        brand: row.brand,
        total_groups: '1',
      },
    ],
  };
}
const now = new Date(workbenchInstant),
  query = parseHomeWorkbenchQuery({});
describe('Home workbench genuine daily observations and bounded SQL', () => {
  it('maps exact metadata/Shanghai Date instant and every known/unknown/empty bucket', () => {
    expect(mapHomeWorkbenchData(raw(), query, now, true)).toEqual(
      homeWorkbenchFixture(),
    );
    expect(mapHomeWorkbenchData(raw(false), query, now, false)).toEqual(
      homeWorkbenchFixture(false),
    );
  });
  it('derives exactly seven Shanghai dates across UTC midnight and host timezones', () => {
    const previous = process.env.TZ;
    try {
      for (const tz of ['UTC', 'America/New_York', 'Asia/Shanghai']) {
        process.env.TZ = tz;
        expect(homeWorkbenchDays(now)).toEqual(workbenchDays);
        expect(
          homeWorkbenchDays(new Date('2026-10-06T15:59:59.999Z')).at(-1),
        ).toBe('2026-10-06');
      }
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
  it('retains only 200 facets and explicitly reports the next-page lookahead', () => {
    const input = raw();
    input.facets = Array.from({ length: 201 }, (_, index) => ({
      ...input.facets[0],
      brand: `Brand ${index}`,
    }));
    const data = mapHomeWorkbenchData(
      input,
      { ...query, facetCurrent: 2 },
      now,
      true,
    );
    expect(data.facets).toHaveLength(200);
    expect(data.facetsTruncated).toBe(true);
    expect(data.facetCurrent).toBe(2);
  });
  it.each([
    'count',
    'time',
    'known',
    'unknown',
    'oversize',
    'unauthorized',
  ] as const)('rejects a corrupt %s driver result', (kind) => {
    const input = raw();
    if (kind === 'count') input.total = '9007199254740992';
    if (kind === 'time') input.list[0].last_check_time = 'invalid';
    if (kind === 'known') input.list[0].trend![0].broken_checks = '4';
    if (kind === 'unknown') input.list[0].trend![0].unknown_checks = '3';
    if (kind === 'oversize') input.list = Array(21).fill(input.list[0]);
    expect(() =>
      mapHomeWorkbenchData(input, query, now, kind !== 'unauthorized'),
    ).toThrow(HomeWorkbenchQueryError);
  });
  it.each([false, true])(
    'executes one MVCC statement; historical read exists only with a current grant (%s)',
    async (grant) => {
      const execute = vi
          .fn()
          .mockResolvedValue({ rows: [{ ...raw(grant), total: '100' }] }),
        ensure = vi.fn();
      const unit = new DrizzleHomeWorkbenchQueryUnit(
        { execute } as unknown as Db,
        ensure,
      );
      const filtered = parseHomeWorkbenchQuery({
        country: 'us',
        site: ' raw site ',
        brand: "fixture' brand",
        keyword: '20%_',
        status: 'BROKEN',
        facetKeyword: 'Tail',
        facetCurrent: 2,
        pageSize: 20,
        current: 3,
      });
      const result = await unit.workbench(filtered, now, grant);
      expect(result.pageSize).toBe(20);
      expect(execute).toHaveBeenCalledOnce();
      const compiled = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
      expect(compiled.params).toEqual(
        expect.arrayContaining([
          'us',
          ' raw site ',
          "fixture' brand",
          '20%_',
          'Tail',
          20,
          40,
          201,
          200,
        ]),
      );
      expect(compiled.sql).not.toContain("fixture' brand");
      expect(compiled.sql).toContain('manual_excluded_from_group');
      expect(compiled.sql).not.toContain('check_result');
      if (grant) {
        expect(compiled.sql).toContain('"monitor_history"');
        expect(compiled.sql).toContain('m.is_broken IS NULL');
        expect(compiled.params).toContain('2026-10-01');
        expect(compiled.params).toContain('2026-10-07 00:05:06.123');
      } else expect(compiled.sql).not.toContain('"monitor_history"');
      expect(ensure).toHaveBeenCalledTimes(2);
    },
  );
  it('keeps an empty brand as a bound equality predicate in the real compiled SQL', async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [raw(false)] });
    const unit = new DrizzleHomeWorkbenchQueryUnit(
      { execute } as unknown as Db,
      vi.fn(),
    );
    await unit.workbench(parseHomeWorkbenchQuery({ brand: '' }), now, false);
    const compiled = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(compiled.sql).toMatch(/g\.brand=\$\d+/);
    expect(compiled.params).toContain('');
    expect(execute).toHaveBeenCalledOnce();
  });
});
