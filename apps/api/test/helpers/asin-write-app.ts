import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AsinModule } from '../../src/asin/asin.module';
import { spApiConfigApp } from './sp-api-config-app';

/** The write fixture includes real constraints AND triggers. LIKE alone does not. */
export async function asinWriteApp() {
  const f = await spApiConfigApp({ imports: [AsinModule] });
  try {
    const pool = f.pools.primaryPool;
    await pool.query(
      'CREATE TABLE variant_groups (LIKE public.variant_groups INCLUDING ALL)',
    );
    await pool.query(
      'CREATE TABLE asins (LIKE public.asins INCLUDING ALL EXCLUDING INDEXES)',
    );
    await pool.query(`ALTER TABLE asins ADD PRIMARY KEY(id),
      ADD CONSTRAINT uk_asins_asin_country UNIQUE(asin,country),
      ADD CONSTRAINT fk_asins_variant_group FOREIGN KEY(variant_group_id) REFERENCES variant_groups(id) ON DELETE CASCADE`);
    await pool.query(
      'CREATE UNIQUE INDEX uq_asins_asin_country_ci ON asins(lower(asin),lower(country))',
    );
    const source = readFileSync(
      resolve(
        __dirname,
        '../../../../packages/db/migrations/0004_asin_timestamp_policy.sql',
      ),
      'utf8',
    ).replaceAll('public', f.schema);
    const connection = await pool.connect();
    try {
      await connection.query(source);
    } catch (error) {
      await connection.query('ROLLBACK');
      throw error;
    } finally {
      await connection.query(`SET search_path TO ${f.schema}`);
      connection.release();
    }
    await pool.query(
      "INSERT INTO role_permissions(role_id,permission_id) SELECT 'writer-71',id FROM permissions WHERE code IN ('asin:read','asin:write')",
    );
    await pool.query(`CREATE FUNCTION fail_asin_parent_touch_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.id='g-fail-touch' THEN RAISE EXCEPTION 'fixture parent touch failure'; END IF; RETURN NEW; END $$`);
    await pool.query(
      'CREATE TRIGGER fail_asin_parent_touch_fixture AFTER UPDATE ON variant_groups FOR EACH ROW EXECUTE FUNCTION fail_asin_parent_touch_fixture()',
    );
    return f;
  } catch (error) {
    await f.close();
    throw error;
  }
}
