import { afterAll, describe, expect, it } from 'vitest';

import { createPgPool } from '../src/client';

const targets = [
  {
    label: 'primary',
    connectionString:
      process.env.DATABASE_URL ??
      'postgresql://postgres:neo_dev_only@127.0.0.1:5432/amazon_asin_monitor',
  },
  {
    label: 'competitor',
    connectionString:
      process.env.COMPETITOR_DATABASE_URL ??
      'postgresql://postgres:neo_dev_only@127.0.0.1:5432/amazon_competitor_monitor',
  },
].map((target) => ({
  ...target,
  expectedDatabase: new URL(target.connectionString).pathname.slice(1),
  pool: createPgPool(target.connectionString, {
    max: 1,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 1_000,
  }),
}));

afterAll(async () => {
  await Promise.all(targets.map(({ pool }) => pool.end()));
});

describe('PostgreSQL 16 + TimescaleDB 双库 smoke test', () => {
  it.each(targets)(
    '$label database 可连接且安装 TimescaleDB',
    async ({ pool, expectedDatabase }) => {
      const result = await pool.query<{
        database_name: string;
        server_version_num: string;
        timescale_version: string | null;
      }>(`
        SELECT
          current_database() AS database_name,
          current_setting('server_version_num') AS server_version_num,
          (
            SELECT extversion
            FROM pg_extension
            WHERE extname = 'timescaledb'
          ) AS timescale_version
      `);

      const row = result.rows[0];
      expect(row.database_name).toBe(expectedDatabase);
      expect(
        Number.parseInt(row.server_version_num, 10),
      ).toBeGreaterThanOrEqual(160_000);
      expect(row.timescale_version).toMatch(/^\d+\.\d+/);
    },
    20_000,
  );

  it('主营与竞品 database 保持隔离', () => {
    expect(targets[0].expectedDatabase).not.toBe(targets[1].expectedDatabase);
  });
});
