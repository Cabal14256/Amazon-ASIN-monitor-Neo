import { customType } from 'drizzle-orm/pg-core';
import { parseShanghaiTimestamp } from '../client';

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * D8: the database stores Beijing wall time; a JavaScript Date is an instant.
 * Drizzle's native timestamp mapper assumes UTC and overrides pg type parsers,
 * so both directions must be defined at the column boundary.
 * Keep the SQL type identical to the existing baseline (no DDL/data rewrite).
 */
export const timestampColumn = customType<{ data: Date; driverData: string }>({
  dataType: () => 'timestamp',
  fromDriver(value) {
    const instant = parseShanghaiTimestamp(value);
    if (!Number.isFinite(instant.getTime())) {
      throw new RangeError('Invalid Beijing database timestamp');
    }
    return instant;
  },
  toDriver(value) {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new RangeError('Invalid timestamp instant');
    }
    return new Date(value.getTime() + BEIJING_OFFSET_MS)
      .toISOString()
      .slice(0, -1)
      .replace('T', ' ');
  },
});
