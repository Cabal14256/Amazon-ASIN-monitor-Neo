import { loadEnv } from '@asin-monitor/config';
import { createPgPool } from '@asin-monitor/db';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { vi } from 'vitest';
import { AuditModule } from '../../src/audit/audit.module';
import { AuditService } from '../../src/audit/audit.service';
import { ENV } from '../../src/config/config.module';
import { ApplicationDatabasePools } from '../../src/database/database.service';
import { configureHttpApp } from '../../src/http-app';
import { AppLogger } from '../../src/logger/app-logger.service';
import { ApplicationRedisClient } from '../../src/redis/redis.service';
import { RoleModule } from '../../src/roles/role.module';
import { UserAdministrationModule } from '../../src/users/user-administration.module';
import { UserQueryModule } from '../../src/users/user-query.module';

const tables = [
  'users',
  'roles',
  'permissions',
  'user_roles',
  'role_permissions',
  'sessions',
  'password_history',
  'login_attempts',
  'user_status_history',
  'audit_logs',
];
const identifier = (value: string) => `"${value.replace(/"/g, '""')}"`;

/** A private schema permits last-administrator tests without changing other fixtures. */
export async function userAdministrationApp() {
  const baseEnv = loadEnv(process.env);
  const schema = `user_admin_61_${randomUUID().replace(/-/g, '')}`;
  const quoted = identifier(schema);
  const bootstrap: Pool = createPgPool(baseEnv.DATABASE_URL, {
    max: 2,
    connectionTimeoutMillis: 2000,
  });
  let created = false;
  let app: NestFastifyApplication | undefined;
  let redis: ApplicationRedisClient | undefined;
  let audit: AuditService | undefined;
  const cacheKeys = new Set<string>();
  const userIds = new Set<string>();
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  const close = async () => {
    try {
      if (audit) await audit.flush();
      if (redis) {
        const owned = [...cacheKeys].filter(
          (key) =>
            key.startsWith('neo:auth:') &&
            [...userIds].some((id) => key.endsWith(`:${id}`)),
        );
        if (owned.length !== cacheKeys.size)
          throw new Error('Unexpected integration cache owner');
        await redis.del(...owned);
      }
    } finally {
      try {
        if (app) await app.close();
      } finally {
        try {
          if (created) {
            if (!/^user_admin_61_[0-9a-f]{32}$/.test(schema))
              throw new Error('Invalid private integration schema');
            await bootstrap.query(`DROP SCHEMA ${quoted} CASCADE`);
          }
        } finally {
          await bootstrap.end();
        }
      }
    }
  };
  try {
    await bootstrap.query(`CREATE SCHEMA ${quoted}`);
    created = true;
    for (const table of tables)
      await bootstrap.query(
        `CREATE TABLE ${quoted}.${identifier(table)} (LIKE public.${identifier(
          table,
        )} INCLUDING ALL)`,
      );
    // LIKE copies CHECK, identity and indexes, but not foreign keys. Rebind the
    // actual baseline FK definitions to the private copies, including cascades.
    const foreignKeys = await bootstrap.query<{
      table_name: string;
      referenced_table: string;
      conname: string;
      definition: string;
    }>(
      "SELECT child.relname AS table_name, parent.relname AS referenced_table, con.conname, pg_get_constraintdef(con.oid) AS definition FROM pg_constraint con JOIN pg_class child ON child.oid=con.conrelid JOIN pg_namespace ns ON ns.oid=child.relnamespace JOIN pg_class parent ON parent.oid=con.confrelid WHERE ns.nspname='public' AND con.contype='f' AND child.relname=ANY($1::text[])",
      [tables],
    );
    for (const fk of foreignKeys.rows) {
      if (!tables.includes(fk.referenced_table))
        throw new Error('Foreign key leaves private authentication tables');
      const definition = fk.definition.replace(
        /REFERENCES (?:public\.)?(?:"[^"]+"|[a-z_][a-z_0-9]*)/,
        `REFERENCES ${quoted}.${identifier(fk.referenced_table)}`,
      );
      if (definition === fk.definition)
        throw new Error('Unable to isolate foreign key target');
      await bootstrap.query(
        `ALTER TABLE ${quoted}.${identifier(
          fk.table_name,
        )} ADD CONSTRAINT ${identifier(fk.conname)} ${definition}`,
      );
    }
    await bootstrap.query(
      `INSERT INTO ${quoted}.permissions SELECT * FROM public.permissions`,
    );
    await bootstrap.query(
      `INSERT INTO ${quoted}.roles(id,code,name) VALUES('role-admin-61','ADMIN','Fixture admin'),('role-manager-61','EDITOR','Fixture manager'),('role-reader-61','READONLY','Fixture reader')`,
    );
    await bootstrap.query(
      `INSERT INTO ${quoted}.role_permissions(role_id,permission_id) SELECT 'role-admin-61',id FROM ${quoted}.permissions`,
    );
    await bootstrap.query(
      `INSERT INTO ${quoted}.role_permissions(role_id,permission_id) SELECT 'role-manager-61',id FROM ${quoted}.permissions WHERE code IN ('user:read','user:write','user:delete','role:read','role:write','audit:read')`,
    );
    await bootstrap.query(
      `INSERT INTO ${quoted}.role_permissions(role_id,permission_id) SELECT 'role-reader-61',id FROM ${quoted}.permissions WHERE code='asin:read'`,
    );
    // Only this schema's deterministic fixture names activate the SQL failures.
    await bootstrap.query(
      `CREATE FUNCTION ${quoted}.reject_fixture_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF OLD.username='reject-delete-61' THEN RAISE EXCEPTION 'fixture-private-delete-failure'; END IF; RETURN OLD; END $$`,
    );
    await bootstrap.query(
      `CREATE TRIGGER reject_fixture_delete AFTER DELETE ON ${quoted}.users FOR EACH ROW EXECUTE FUNCTION ${quoted}.reject_fixture_delete()`,
    );
    await bootstrap.query(
      `CREATE FUNCTION ${quoted}.reject_fixture_role() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF EXISTS(SELECT 1 FROM ${quoted}.users WHERE id=NEW.user_id AND username='reject-role-61') THEN RAISE EXCEPTION 'fixture-private-role-failure'; END IF; RETURN NEW; END $$`,
    );
    await bootstrap.query(
      `CREATE TRIGGER reject_fixture_role AFTER INSERT ON ${quoted}.user_roles FOR EACH ROW EXECUTE FUNCTION ${quoted}.reject_fixture_role()`,
    );
    const databaseUrl = new URL(baseEnv.DATABASE_URL);
    databaseUrl.searchParams.set('options', `-c search_path=${schema},public`);
    const env = {
      ...baseEnv,
      DATABASE_URL: databaseUrl.toString(),
      AUTH_DATA_AUTHORITY: 'postgresql' as const,
    };
    const module = await Test.createTestingModule({
      imports: [
        UserAdministrationModule,
        UserQueryModule,
        RoleModule,
        AuditModule,
      ],
    })
      .overrideProvider(ENV)
      .useValue(env)
      .overrideProvider(AppLogger)
      .useValue(logger)
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ logger: false }),
    );
    const activeAudit = app.get<AuditService>(AuditService);
    const activeRedis = app.get<ApplicationRedisClient>(ApplicationRedisClient);
    audit = activeAudit;
    redis = activeRedis;
    const setex = activeRedis.setex.bind(activeRedis);
    vi.spyOn(activeRedis, 'setex').mockImplementation(
      async (key, ttl, value) => {
        cacheKeys.add(key);
        return setex(key, ttl, value);
      },
    );
    configureHttpApp(app, {
      logger: logger as unknown as AppLogger,
      audit: activeAudit,
    });
    await app.init();
    const http = app.getHttpAdapter().getInstance();
    await http.ready();
    const pools = app.get(ApplicationDatabasePools);
    const resolved = await pools.primaryPool.query(
      'SELECT current_schema() AS name',
    );
    if (resolved.rows[0].name !== schema)
      throw new Error('Application escaped the private integration schema');
    return {
      app,
      http,
      env,
      logger,
      pools,
      redis: activeRedis,
      audit: activeAudit,
      userIds,
      close,
      schema,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
