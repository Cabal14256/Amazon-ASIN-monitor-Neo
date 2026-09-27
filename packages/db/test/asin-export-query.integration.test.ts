import { sql } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createPgPool } from '../src/client';
import { withAsinExportDatabaseTransaction } from '../src/repositories/asin-query-repository';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'ASIN export database deadline',
  () => {
    it('completes a query past the authentication deadline', async () => {
      const pool = createPgPool(process.env.DATABASE_URL!, {
        max: 1,
        connectionTimeoutMillis: 2000,
        statement_timeout: 1500,
      });
      try {
        const result = await withAsinExportDatabaseTransaction(pool, (db) =>
          db.execute(sql`SELECT pg_sleep(2.1) AS slept`),
        );
        expect(result.rows).toHaveLength(1);
      } finally {
        await pool.end();
      }
    }, 10_000);
  },
);
