import { eq, getTableColumns, gte } from 'drizzle-orm';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/client';
import { auditLogs, sessions, users } from '../src/schema';
import { competitorVariantGroups } from '../src/schema-competitor';
import {
  competitorDrizzleTables,
  primaryDrizzleTables,
} from './schema-fixtures';

const instant = new Date('2026-09-06T04:30:15.123Z');
const wallTime = '2026-09-06 12:30:15.123';

describe('Drizzle D8 timestamp mapping', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(['UTC', 'Asia/Shanghai', 'America/New_York'])(
    'preserves cross-day instants under host TZ=%s',
    (timezone) => {
      vi.stubEnv('TZ', timezone);
      const beforeNewYear = new Date('2026-12-31T20:15:00.789Z');
      expect(auditLogs.createTime.mapToDriverValue(beforeNewYear)).toBe(
        '2027-01-01 04:15:00.789',
      );
      expect(
        auditLogs.createTime.mapFromDriverValue('2027-01-01 04:15:00.789'),
      ).toEqual(beforeNewYear);
      expect(
        auditLogs.createTime.mapFromDriverValue('2026-09-06 00:30:00'),
      ).toEqual(new Date('2026-09-05T16:30:00Z'));
    },
  );

  it('rejects invalid instants instead of writing a misleading timestamp', () => {
    expect(() => auditLogs.createTime.mapToDriverValue(new Date(NaN))).toThrow(
      'Invalid timestamp instant',
    );
    expect(() => auditLogs.createTime.mapFromDriverValue('infinity')).toThrow(
      'Invalid Beijing database timestamp',
    );
  });
  it.each([
    { name: 'primary session', table: sessions, column: sessions.expiresAt },
    {
      name: 'competitor check',
      table: competitorVariantGroups,
      column: competitorVariantGroups.lastCheckTime,
    },
  ])(
    'reads $name through the actual ORM result mapper as a Beijing instant',
    async ({ table, column }) => {
      const query = vi.fn().mockResolvedValue({ rows: [[wallTime]] });
      const db = createDb({ query } as unknown as Pool);
      const [row] = await db.select({ time: column }).from(table);
      expect(row.time?.toISOString()).toBe(instant.toISOString());
    },
  );

  it('encodes Date writes and range predicates as Beijing wall time', () => {
    const db = createDb({} as Pool);
    expect(
      db
        .update(users)
        .set({ passwordExpiresAt: instant })
        .where(eq(users.id, 'fixture'))
        .toSQL().params,
    ).toEqual([wallTime, 'fixture']);
    expect(
      db
        .update(competitorVariantGroups)
        .set({ lastCheckTime: instant })
        .where(eq(competitorVariantGroups.id, 'fixture'))
        .toSQL().params,
    ).toEqual([wallTime, 'fixture']);
    expect(
      db
        .select()
        .from(auditLogs)
        .where(gte(auditLogs.createTime, instant))
        .toSQL().params,
    ).toEqual([wallTime]);
  });

  it('preserves SQL NULL and optional timestamps', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [[null]] });
    const db = createDb({ query } as unknown as Pool);
    expect(
      await db.select({ time: auditLogs.createTime }).from(auditLogs),
    ).toEqual([{ time: null }]);
    expect(
      db
        .update(users)
        .set({ lockedUntil: null })
        .where(eq(users.id, 'fixture'))
        .toSQL().params,
    ).toEqual([null, 'fixture']);
  });

  it('applies the same mapping to every timestamp in both schemas without changing SQL types', () => {
    let count = 0;
    for (const table of [...primaryDrizzleTables, ...competitorDrizzleTables]) {
      for (const column of Object.values(getTableColumns(table))) {
        if (column.getSQLType() !== 'timestamp') continue;
        count++;
        expect(column.mapFromDriverValue(wallTime)).toEqual(instant);
        expect(column.mapToDriverValue(instant)).toBe(wallTime);
      }
    }
    expect(count).toBeGreaterThan(40);
  });
});
