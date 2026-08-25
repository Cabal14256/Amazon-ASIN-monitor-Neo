import { defineConfig } from 'drizzle-kit';

/**
 * 竞品库（平移旧 MySQL amazon_competitor_monitor，决策 D6：PG 两个独立 database）。
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema-competitor',
  out: './drizzle-competitor',
  dbCredentials: {
    url:
      process.env.COMPETITOR_DATABASE_URL ??
      'postgres://localhost:5432/amazon_competitor_monitor',
  },
  strict: true,
  verbose: true,
});
