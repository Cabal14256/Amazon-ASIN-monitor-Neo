import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import type { Db } from '../src/client';
import { DrizzleAsinQueryUnit } from '../src/repositories/asin-query-repository';
import { DrizzleCompetitorReadUnit } from '../src/repositories/competitor-read-unit';

describe.each(['primary', 'competitor'] as const)(
  '%s literal catalog query candidates',
  (domain) => {
    it('keeps exact C comparisons and adds native-column equality for every indexed lookup', async () => {
      const dialect = new PgDialect();
      const execute = vi.fn(async (_statement: SQL) => ({
        rows: [{ groups: [], asins: [], total: '0', total_asins: '0' }],
      }));
      const database = { execute } as unknown as Db;
      const unit =
        domain === 'primary'
          ? new DrizzleAsinQueryUnit(database, () => {})
          : new DrizzleCompetitorReadUnit(database, () => {});
      await unit.detail(' Raw /?# ', 'literal');
      const query = dialect.sqlToQuery(execute.mock.calls[0][0]);
      // Parent PK, correlated child count, and selected-parent child join must
      // all expose an equality in the column's own collation. The C predicate
      // remains the independent byte-exact filter, including padding and case.
      expect(query.sql).toMatch(/"g"\."id" = \$\d+/);
      expect(query.sql).toMatch(/"a"\."variant_group_id" = "g"\."id"/);
      expect(query.sql).toMatch(
        domain === 'primary'
          ? /p\.id = "a"\."variant_group_id"/
          : /"a"\."variant_group_id" = p\.id/,
      );
      expect(query.sql.match(/COLLATE "C" = /g)).toHaveLength(3);
      expect(
        query.params.filter((value) => value === ' Raw /?# '),
      ).toHaveLength(2);
      expect(query.sql).not.toContain('rtrim');
      expect(query.sql).not.toContain('neo_competitor_query_ci');
    });
  },
);
