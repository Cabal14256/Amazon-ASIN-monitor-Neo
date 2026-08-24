import { defineConfig } from 'drizzle-kit';

/**
 * 主库（平移旧 MySQL amazon_asin_monitor）。
 * P1-T2 将落地 0000_baseline.sql（由 init.sql + 33 个迁移翻译而来）。
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/amazon_asin_monitor',
  },
  strict: true,
  verbose: true,
});
