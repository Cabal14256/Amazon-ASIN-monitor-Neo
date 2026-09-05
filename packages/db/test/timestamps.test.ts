import { getTableColumns } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { sessions, users } from '../src/schema';
import {
  formatShanghaiTimestamp,
  parseShanghaiTimestamp,
} from '../src/timestamps';
import {
  competitorDrizzleTables,
  primaryDrizzleTables,
} from './schema-fixtures';

describe('D8 Drizzle timestamp codecs', () => {
  it.each([
    ['2026-09-05T10:00:00.123Z', '2026-09-05 18:00:00.123'],
    ['2026-12-31T20:00:00.999Z', '2027-01-01 04:00:00.999'],
    ['2024-02-29T23:00:00.000Z', '2024-03-01 07:00:00.000'],
  ])(
    'round trips the same instant across date boundaries (%s)',
    (utc, local) => {
      const date = new Date(utc);
      expect(formatShanghaiTimestamp(date)).toBe(local);
      expect(parseShanghaiTimestamp(local)).toEqual(date);
    },
  );
  it('all primary and competitor timestamp columns use the D8 codec without DDL changes', () => {
    let count = 0;
    const date = new Date('2026-09-05T10:00:00.123Z');
    for (const table of [...primaryDrizzleTables, ...competitorDrizzleTables]) {
      for (const column of Object.values(getTableColumns(table))) {
        if (column.getSQLType() !== 'timestamp without time zone') continue;
        count++;
        expect(column.mapToDriverValue(date)).toBe('2026-09-05 18:00:00.123');
        expect(column.mapFromDriverValue('2026-09-05 18:00:00.123')).toEqual(
          date,
        );
      }
    }
    expect(count).toBeGreaterThan(50);
  });
  it('the real Drizzle node-postgres read path decodes raw strings despite parser overrides', async () => {
    const query = vi
      .fn()
      .mockResolvedValue({ rows: [['2026-09-05 18:00:00.123']] });
    const db = drizzle({ query } as unknown as Pool);
    expect(
      await db.select({ expiresAt: sessions.expiresAt }).from(sessions),
    ).toEqual([{ expiresAt: new Date('2026-09-05T10:00:00.123Z') }]);
    expect(query).toHaveBeenCalledOnce();
  });
  it('compiled lockout and session writes carry Shanghai wall time, not a UTC ISO string', () => {
    const db = drizzle({} as Pool);
    const date = new Date('2026-09-05T10:00:00.123Z');
    const patch = db.update(users).set({ lockedUntil: date }).toSQL();
    const insert = db
      .insert(sessions)
      .values({
        id: '00000000-0000-0000-0000-000000000031',
        userId: 'fixture',
        expiresAt: date,
      })
      .toSQL();
    expect(patch.params).toContain('2026-09-05 18:00:00.123');
    expect(insert.params).toContain('2026-09-05 18:00:00.123');
    expect([...patch.params, ...insert.params]).not.toContain(
      date.toISOString(),
    );
  });
});
