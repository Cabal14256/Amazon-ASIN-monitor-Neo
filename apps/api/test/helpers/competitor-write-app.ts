import { createPgPool } from '@asin-monitor/db';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CompetitorModule } from '../../src/competitor/competitor.module';
import { spApiConfigApp } from './sp-api-config-app';

export async function competitorWriteApp() {
  if (
    process.env.RUN_INTEGRATION_TESTS !== 'true' ||
    process.env.INTEGRATION_ALLOW_DROP_DATABASES !== 'true' ||
    !process.env.COMPETITOR_DATABASE_URL
  )
    throw new Error(
      'Disposable competitor integration fixtures must be enabled',
    );
  const schema = `competitor_write_121_${randomUUID().replace(/-/g, '')}`;
  const admin = createPgPool(process.env.COMPETITOR_DATABASE_URL, {
    max: 2,
    connectionTimeoutMillis: 2000,
  });
  let fixture: Awaited<ReturnType<typeof spApiConfigApp>> | undefined,
    created = false;
  const close = async () => {
    try {
      await fixture?.close();
    } finally {
      try {
        if (created) {
          if (!/^competitor_write_121_[0-9a-f]{32}$/.test(schema))
            throw new Error('Unsafe competitor write fixture schema');
          await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        }
      } finally {
        await admin.end();
      }
    }
  };
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await admin.query(
      `CREATE TABLE "${schema}".competitor_variant_groups (LIKE public.competitor_variant_groups INCLUDING ALL)`,
    );
    await admin.query(
      `CREATE TABLE "${schema}".competitor_asins (LIKE public.competitor_asins INCLUDING ALL EXCLUDING INDEXES)`,
    );
    await admin.query(
      `CREATE TABLE "${schema}".competitor_monitor_history (LIKE public.competitor_monitor_history INCLUDING ALL)`,
    );
    await admin.query(
      `ALTER TABLE "${schema}".competitor_asins ADD PRIMARY KEY(id), ADD CONSTRAINT uk_competitor_asins_asin_country UNIQUE(asin,country), ADD CONSTRAINT fk_competitor_asins_variant_group FOREIGN KEY(variant_group_id) REFERENCES "${schema}".competitor_variant_groups(id) ON DELETE CASCADE`,
    );
    await admin.query(
      `CREATE UNIQUE INDEX uq_competitor_asins_asin_country_ci ON "${schema}".competitor_asins(lower(asin),lower(country))`,
    );
    await admin.query(
      `CREATE UNIQUE INDEX idx_neo_competitor_query_asin_id ON "${schema}".competitor_asins ((rtrim(id) COLLATE public.neo_competitor_query_ci))`,
    );
    const url = new URL(process.env.COMPETITOR_DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const f = await spApiConfigApp({
      imports: [CompetitorModule],
      env: { COMPETITOR_DATABASE_URL: url.toString() },
    });
    fixture = f;
    const baseline = readFileSync(
      resolve(
        __dirname,
        '../../../../packages/db/migrations/0000_baseline.sql',
      ),
      'utf8',
    ).match(
      /CREATE OR REPLACE FUNCTION set_updated_timestamp_column\(\)[\s\S]*?\$\$;/,
    )?.[0];
    if (!baseline) throw new Error('Missing baseline timestamp function');
    await f.pools.competitorPool.query(baseline);
    const migration = (down: boolean) => {
      let source = readFileSync(
        resolve(
          __dirname,
          `../../../../packages/db/migrations/0011_competitor_write_policy${
            down ? '.rollback' : ''
          }.sql`,
        ),
        'utf8',
      );
      for (const name of [
        'competitor_variant_groups',
        'competitor_asins',
        'set_competitor_update_timestamp',
        'set_updated_timestamp_column',
        'idx_neo_competitor_write_asin_country',
      ])
        source = source.replaceAll(`public.${name}`, `"${schema}".${name}`);
      return source;
    };
    const applyPolicy = async (down = false) => {
      const client = await f.pools.competitorPool.connect();
      try {
        await client.query(migration(down));
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    };
    await applyPolicy();
    await f.pools.primaryPool.query(
      "INSERT INTO role_permissions(role_id,permission_id) SELECT 'writer-71',id FROM permissions WHERE code IN ('asin:write','asin:read') ON CONFLICT DO NOTHING",
    );
    await f.pools.primaryPool.query(
      "CREATE TABLE competitor_variant_groups(id text PRIMARY KEY,name text); INSERT INTO competitor_variant_groups VALUES('g1','wrong-primary-data')",
    );
    const databaseNames = await Promise.all([
      f.pools.primaryPool.query('SELECT current_database() AS name'),
      f.pools.competitorPool.query('SELECT current_database() AS name'),
    ]);
    if (databaseNames[0].rows[0].name === databaseNames[1].rows[0].name)
      throw new Error('Competitor fixture must use two databases');
    if (
      (await f.pools.competitorPool.query('SELECT current_schema() AS name'))
        .rows[0].name !== schema
    )
      throw new Error('Competitor fixture escaped private schema');
    if (
      (
        await f.pools.competitorPool.query(
          "SELECT to_regclass('users') AS value",
        )
      ).rows[0].value !== null
    )
      throw new Error('Competitor fixture must not contain accounts');
    return { ...f, competitorSchema: schema, applyPolicy, close };
  } catch (error) {
    await close();
    throw error;
  }
}
