import { loadEnv } from '@asin-monitor/config';
import { createPgPool } from '@asin-monitor/db';
import type { ModuleMetadata } from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test, type TestingModuleBuilder } from '@nestjs/testing';
import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import { AuditModule } from '../../src/audit/audit.module';
import { AuditService } from '../../src/audit/audit.service';
import { ENV } from '../../src/config/config.module';
import { ApplicationDatabasePools } from '../../src/database/database.service';
import { configureHttpApp } from '../../src/http-app';
import { AppLogger } from '../../src/logger/app-logger.service';
import { ApplicationRedisClient } from '../../src/redis/redis.service';
import { SpApiConfigModule } from '../../src/sp-api-config/sp-api-config.module';
import { SP_API_CONFIG_ENV } from '../../src/sp-api-config/sp-api-config.service';

/** Real providers and transactions, isolated from public data and credentials. */
export async function spApiConfigApp(
  options: {
    imports?: ModuleMetadata['imports'];
    configure?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
  } = {},
) {
  const baseEnv = loadEnv(process.env);
  const schema = `spapi_config_71_${randomUUID().replace(/-/g, '')}`;
  const quoted = `"${schema}"`;
  const bootstrap = createPgPool(baseEnv.DATABASE_URL, {
    max: 2,
    connectionTimeoutMillis: 2000,
  });
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
    'sp_api_config',
  ];
  const userIds = new Set<string>();
  const keys = new Set<string>();
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  let created = false;
  let app: NestFastifyApplication | undefined;
  let audit: AuditService | undefined;
  let redis: ApplicationRedisClient | undefined;
  const close = async () => {
    try {
      if (audit) await audit.flush();
      if (redis && keys.size) {
        if (
          [...keys].some(
            (key) =>
              !key.startsWith('neo:auth:') ||
              ![...userIds].some((id) => key.endsWith(`:${id}`)),
          )
        )
          throw new Error('Unexpected configuration fixture cache owner');
        await redis.del(...keys);
      }
    } finally {
      try {
        if (app) await app.close();
      } finally {
        try {
          if (created) {
            if (!/^spapi_config_71_[0-9a-f]{32}$/.test(schema))
              throw new Error('Invalid configuration fixture schema');
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
        `CREATE TABLE ${quoted}."${table}" (LIKE public."${table}" INCLUDING ALL)`,
      );
    await bootstrap.query(
      `CREATE VIEW ${quoted}.audit_logs_all AS SELECT * FROM ${quoted}.audit_logs`,
    );
    await bootstrap.query(
      `INSERT INTO ${quoted}.permissions SELECT * FROM public.permissions`,
    );
    await bootstrap.query(
      `INSERT INTO ${quoted}.roles(id,code,name) VALUES('writer-71','ADMIN','Fixture writer'),('reader-71','READONLY','Fixture reader')`,
    );
    await bootstrap.query(
      `INSERT INTO ${quoted}.role_permissions(role_id,permission_id) SELECT 'writer-71',id FROM ${quoted}.permissions WHERE code IN ('settings:read','settings:write')`,
    );
    await bootstrap.query(
      `INSERT INTO ${quoted}.role_permissions(role_id,permission_id) SELECT 'reader-71',id FROM ${quoted}.permissions WHERE code='settings:read'`,
    );
    await bootstrap.query(
      `CREATE FUNCTION ${quoted}.reject_config_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.config_value='reject-private-fixture-71' THEN RAISE EXCEPTION 'reject-private-fixture-71'; END IF; RETURN NEW; END $$`,
    );
    await bootstrap.query(
      `CREATE TRIGGER reject_config_fixture AFTER INSERT OR UPDATE ON ${quoted}.sp_api_config FOR EACH ROW EXECUTE FUNCTION ${quoted}.reject_config_fixture()`,
    );
    const databaseUrl = new URL(baseEnv.DATABASE_URL);
    // No public fallback: a missing fixture relation must fail, never touch real data.
    databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
    const env = {
      ...baseEnv,
      DATABASE_URL: databaseUrl.toString(),
      AUTH_DATA_AUTHORITY: 'postgresql' as const,
    };
    const builder = Test.createTestingModule({
      imports: [SpApiConfigModule, AuditModule, ...(options.imports ?? [])],
    })
      .overrideProvider(ENV)
      .useValue(env)
      .overrideProvider(AppLogger)
      .useValue(logger)
      .overrideProvider(SP_API_CONFIG_ENV)
      .useValue({
        SP_API_LWA_CLIENT_ID: 'fixture-client-71',
        SP_API_LWA_CLIENT_SECRET: 'fixture-env-secret-71',
        SP_API_REFRESH_TOKEN: 'fixture-refresh-71',
      });
    const module = await (options.configure
      ? options.configure(builder)
      : builder
    ).compile();
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
        keys.add(key);
        return setex(key, ttl, value);
      },
    );
    configureHttpApp(app, { audit, logger: logger as unknown as AppLogger });
    await app.init();
    const http = app.getHttpAdapter().getInstance();
    await http.ready();
    const pools = app.get(ApplicationDatabasePools);
    const resolved = await pools.primaryPool.query(
      "SELECT current_schema() AS name, current_setting('search_path') AS path",
    );
    if (resolved.rows[0].name !== schema || resolved.rows[0].path !== schema)
      throw new Error('Configuration fixture escaped private schema');
    return {
      app,
      http,
      pools,
      env,
      logger,
      audit: activeAudit,
      redis: activeRedis,
      userIds,
      schema,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
