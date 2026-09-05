import { customType } from 'drizzle-orm/pg-core';

const pattern = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/;

/** D8: database wall-clock timestamps always represent UTC+8, not host time. */
export function parseShanghaiTimestamp(value: string): Date {
  const match = pattern.exec(value);
  if (!match) return new Date(value);
  return new Date(`${match[1]}T${match[2]}+08:00`);
}

export function formatShanghaiTimestamp(value: Date): string {
  return new Date(value.getTime() + 8 * 3600_000)
    .toISOString()
    .slice(0, -1)
    .replace('T', ' ');
}

// node-postgres Drizzle overrides the pool's timestamp parser with raw strings.
// Both directions must therefore be handled at the column codec, not only OID 1114.
export const shanghaiTimestamp = customType<{
  data: Date;
  driverData: string;
}>({
  // Preserve Drizzle's original SQL spelling: the migration registry maps this
  // alias to Legacy DATETIME and to pg_catalog's timestamp without time zone.
  dataType: () => 'timestamp',
  fromDriver: parseShanghaiTimestamp,
  toDriver: formatShanghaiTimestamp,
});
