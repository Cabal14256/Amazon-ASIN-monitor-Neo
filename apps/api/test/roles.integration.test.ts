import { loadEnv } from '@asin-monitor/config';
import {
  assignPermissionsResultSchema,
  permissionListResultSchema,
  roleDetailResultSchema,
} from '@asin-monitor/contracts';
import {
  BoundedAuthRepository,
  PgRoleRepository,
  type RoleRepositoryPort,
} from '@asin-monitor/db';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditModule } from '../src/audit/audit.module';
import { AuditService } from '../src/audit/audit.service';
import { PermissionCacheService } from '../src/auth/permission-cache.service';
import { ENV } from '../src/config/config.module';
import { ApplicationDatabasePools } from '../src/database/database.service';
import { configureHttpApp } from '../src/http-app';
import { AppLogger } from '../src/logger/app-logger.service';
import { ApplicationRedisClient } from '../src/redis/redis.service';
import { RoleModule } from '../src/roles/role.module';
import { ROLE_REPOSITORY } from '../src/roles/role.service';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'Neo role management / real PostgreSQL and Redis',
  () => {
    let app: NestFastifyApplication;
    let pools: ApplicationDatabasePools;
    let repository: RoleRepositoryPort;
    let audit: AuditService;
    let redis: ApplicationRedisClient;
    const userIds: string[] = [];
    const roleIds: string[] = [];
    const permissionIds: string[] = [];
    const cacheKeys = new Set<string>();
    const critical = [
      'user:read',
      'user:write',
      'user:delete',
      'role:read',
      'role:write',
      'audit:read',
    ];
    let standard: { id: string; code: string }[];
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const env = () => ({
      ...loadEnv(process.env),
      AUTH_DATA_AUTHORITY: 'postgresql' as const,
    });
    beforeAll(async () => {
      const module = await Test.createTestingModule({
        imports: [RoleModule, AuditModule],
      })
        .overrideProvider(ENV)
        .useValue(env())
        .overrideProvider(AppLogger)
        .useValue(logger)
        .compile();
      app = module.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter({ logger: false }),
      );
      pools = app.get(ApplicationDatabasePools);
      repository = app.get(ROLE_REPOSITORY);
      audit = app.get(AuditService);
      redis = app.get(ApplicationRedisClient);
      expect(repository).toBeInstanceOf(PgRoleRepository);
      const setex = redis.setex.bind(redis);
      vi.spyOn(redis, 'setex').mockImplementation(async (key, ttl, value) => {
        cacheKeys.add(key);
        return setex(key, ttl, value);
      });
      configureHttpApp(app, { logger: logger as unknown as AppLogger, audit });
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
      standard = (
        await pools.primaryPool.query(
          'SELECT id,code FROM permissions WHERE code=ANY($1::text[]) ORDER BY code',
          [critical],
        )
      ).rows;
      expect(standard).toHaveLength(6);
    });
    afterAll(async () => {
      try {
        if (audit) await audit.flush();
        if (pools && userIds.length) {
          await pools.primaryPool.query(
            'DELETE FROM audit_logs WHERE user_id=ANY($1::text[])',
            [userIds],
          );
          await pools.primaryPool.query(
            'DELETE FROM users WHERE id=ANY($1::text[])',
            [userIds],
          );
        }
        if (pools && roleIds.length)
          await pools.primaryPool.query(
            'DELETE FROM roles WHERE id=ANY($1::text[])',
            [roleIds],
          );
        if (pools && permissionIds.length)
          await pools.primaryPool.query(
            'DELETE FROM permissions WHERE id=ANY($1::text[])',
            [permissionIds],
          );
        if (redis && cacheKeys.size) {
          const owned = [...cacheKeys].filter(
            (key) =>
              key.startsWith('neo:auth:') &&
              userIds.some((id) => key.endsWith(`:${id}`)),
          );
          expect(owned).toHaveLength(cacheKeys.size);
          await redis.del(...owned);
        }
      } finally {
        vi.restoreAllMocks();
        if (app) await app.close();
      }
    });
    async function fixture() {
      const id = `u57-${randomUUID()}`;
      const operatorRole = `r57-${randomUUID()}`;
      const targetRole = `r57-${randomUUID()}`;
      const sessionId = randomUUID();
      userIds.push(id);
      roleIds.push(operatorRole, targetRole);
      await pools.primaryPool.query(
        "INSERT INTO users(id,username,password,force_password_change) VALUES($1,$1,'fixture-unused-hash',false)",
        [id],
      );
      await pools.primaryPool.query(
        "INSERT INTO roles(id,code,name) VALUES($1,$1,'Fixture operator'),($2,$2,'Fixture target')",
        [operatorRole, targetRole],
      );
      await pools.primaryPool.query(
        'INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)',
        [id, operatorRole],
      );
      await pools.primaryPool.query(
        'INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code=ANY($2::text[])',
        [operatorRole, critical],
      );
      await pools.primaryPool.query(
        "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,'2099-01-01 08:00:00')",
        [sessionId, id],
      );
      const headers = {
        authorization: `Bearer ${jwt.sign(
          { userId: id, sessionId },
          env().JWT_SECRET,
          { expiresIn: '1h' },
        )}`,
      };
      const get = (path: string) =>
        app
          .getHttpAdapter()
          .getInstance()
          .inject({ method: 'GET', url: `/api/v1${path}`, headers });
      const assign = (ids: string[], role = targetRole) =>
        app
          .getHttpAdapter()
          .getInstance()
          .inject({
            method: 'PUT',
            url: `/api/v1/roles/${role}/permissions`,
            headers,
            payload: { permissionIds: ids },
          });
      return { id, operatorRole, targetRole, sessionId, headers, get, assign };
    }
    const stored = async (roleId: string) =>
      (
        await pools.primaryPool.query(
          'SELECT permission_id FROM role_permissions WHERE role_id=$1 ORDER BY permission_id',
          [roleId],
        )
      ).rows.map((row) => row.permission_id as string);
    const permission = (code: string) =>
      standard.find((row) => row.code === code)!.id;

    it('persists a role replacement and its audit, then invalidates another instance cache', async () => {
      const f = await fixture();
      await pools.primaryPool.query(
        'INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)',
        [f.id, f.targetRole],
      );
      const required = standard.map((row) => row.id);
      expect((await f.assign(required)).statusCode).toBe(200); // Self-role invariant requires all six.
      const response = await f.get(`/roles/${f.targetRole}`);
      expect(response.statusCode).toBe(200);
      expect(
        roleDetailResultSchema.parse(response.json()).data?.permissions,
      ).toHaveLength(6);
      const foreign = await fixture();
      // A second process-equivalent cache shares Redis and the authoritative repository.
      const cache = new PermissionCacheService(
        env(),
        redis,
        new BoundedAuthRepository(pools.primaryPool),
        logger as unknown as AppLogger,
      );
      const before = await cache.getPermissions(foreign.id);
      expect(before).toContain('role:write');
      const result = await f.assign(
        required.filter((id) => id !== permission('role:write')),
        foreign.operatorRole,
      );
      expect(result.statusCode).toBe(200); // The operator is not a member of this role.
      expect(
        assignPermissionsResultSchema.parse(result.json()).data?.roleId,
      ).toBe(foreign.operatorRole);
      expect(await stored(foreign.operatorRole)).not.toContain(
        permission('role:write'),
      );
      expect(await cache.getPermissions(foreign.id)).not.toContain(
        'role:write',
      );
      expect((await foreign.assign([])).statusCode).toBe(403);
      await audit.flush();
      const entries = (
        await pools.primaryPool.query(
          'SELECT * FROM audit_logs WHERE user_id=$1 AND resource_id=$2',
          [f.id, foreign.operatorRole],
        )
      ).rows;
      expect(
        entries.some(
          (row) =>
            row.response_status === 200 &&
            row.action === 'UPDATE_ROLE_PERMISSIONS',
        ),
      ).toBe(true);
      expect(JSON.stringify(entries)).not.toContain(f.headers.authorization);
    });
    it('preserves nullable permission metadata, dates and the other resource group', async () => {
      const f = await fixture();
      const id = `p57-${randomUUID()}`;
      permissionIds.push(id);
      await pools.primaryPool.query(
        "INSERT INTO permissions(id,code,name,resource,action,create_time) VALUES($1,$1,'Fixture nullable',NULL,NULL,NULL)",
        [id],
      );
      expect((await f.assign([id])).statusCode).toBe(200);
      const detail = roleDetailResultSchema.parse(
        (await f.get(`/roles/${f.targetRole}`)).json(),
      ).data!;
      expect(detail.permissions?.[0]).toMatchObject({
        id,
        resource: null,
        action: null,
      });
      const list = permissionListResultSchema.parse(
        (await f.get('/permissions')).json(),
      ).data!;
      expect(
        list.grouped.other.some(
          (row) => row.id === id && row.create_time === undefined,
        ),
      ).toBe(true);
      expect(list.list.find((row) => row.id === id)?.create_time).toBeNull();
    });
    it('reads role metadata and permissions from one snapshot while another transaction commits', async () => {
      const f = await fixture();
      expect((await f.assign([permission('role:read')])).statusCode).toBe(200);
      const snapshot = await repository.read(async (unit) => {
        expect((await unit.findRole(f.targetRole))?.id).toBe(f.targetRole);
        await repository.transaction((writer) =>
          writer.replacePermissions(f.targetRole, [permission('role:write')]),
        );
        return unit.listRolePermissions(f.targetRole);
      });
      expect(snapshot.map((row) => row.code)).toEqual(['role:read']);
      expect(await stored(f.targetRole)).toEqual([permission('role:write')]);
    });
    it('protects the operator role and rolls back a failure after actual delete/insert', async () => {
      const f = await fixture();
      expect((await f.assign([], f.operatorRole)).statusCode).toBe(400);
      const original = repository.transaction.bind(repository);
      const spy = vi
        .spyOn(repository, 'transaction')
        .mockImplementation((operation) =>
          original((unit) =>
            operation(
              new Proxy(unit, {
                get(target, key) {
                  if (key === 'replacePermissions')
                    return async (roleId: string, ids: string[]) => {
                      await target.replacePermissions(roleId, ids);
                      throw new Error('fixture SQL secret failure');
                    };
                  const value = Reflect.get(target, key);
                  return typeof value === 'function'
                    ? value.bind(target)
                    : value;
                },
              }),
            ),
          ),
        );
      try {
        expect((await f.assign([permission('role:read')])).statusCode).toBe(
          500,
        );
      } finally {
        spy.mockRestore();
      }
      expect(await stored(f.targetRole)).toEqual([]);
      expect(await stored(f.operatorRole)).toHaveLength(6);
      expect(JSON.stringify(logger.error.mock.calls)).not.toContain(
        'fixture SQL secret',
      );
    });
    it('serializes concurrent role replacements under the shared administration lock', async () => {
      const f = await fixture();
      const entered = deferred();
      const release = deferred();
      const first = repository.transaction(async (unit) => {
        await unit.replacePermissions(f.targetRole, [permission('role:read')]);
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const second = f.assign([permission('role:write')]);
      try {
        await vi.waitFor(
          async () =>
            expect(
              Number(
                (
                  await pools.primaryPool.query(
                    "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=1095977294 AND objid=1380073795 AND NOT granted",
                  )
                ).rows[0].count,
              ),
            ).toBeGreaterThan(0),
          { timeout: 1000 },
        );
      } finally {
        release.resolve();
      }
      await first;
      expect((await second).statusCode).toBe(200);
      expect(await stored(f.targetRole)).toEqual([permission('role:write')]);
    });
    it('rejects permission revoked while a previously authorized request waits for the lock', async () => {
      const f = await fixture();
      const connection = await pools.primaryPool.connect();
      await connection.query('BEGIN');
      await connection.query(
        'SELECT pg_advisory_xact_lock(1095977294,1380073795)',
      );
      const spy = vi.spyOn(repository, 'transaction');
      const pending = f.assign([permission('role:read')]);
      try {
        await vi.waitFor(() => expect(spy).toHaveBeenCalled(), {
          timeout: 1000,
        });
        await connection.query(
          'DELETE FROM role_permissions WHERE role_id=$1 AND permission_id=$2',
          [f.operatorRole, permission('role:write')],
        );
        await connection.query('COMMIT');
      } finally {
        await connection.query('ROLLBACK');
        connection.release();
        spy.mockRestore();
      }
      expect((await pending).statusCode).toBe(403);
      expect(await stored(f.targetRole)).toEqual([]);
    });
    it('does not apply a delayed write after the PostgreSQL lock timeout', async () => {
      const f = await fixture();
      const connection = await pools.primaryPool.connect();
      await connection.query('BEGIN');
      await connection.query(
        'SELECT pg_advisory_xact_lock(1095977294,1380073795)',
      );
      try {
        expect((await f.assign([permission('role:read')])).statusCode).toBe(
          500,
        );
      } finally {
        await connection.query('ROLLBACK');
        connection.release();
      }
      expect(await stored(f.targetRole)).toEqual([]);
    });
  },
);
