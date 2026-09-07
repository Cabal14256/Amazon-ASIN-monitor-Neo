import {
  batchDeleteResultSchema,
  createUserResultSchema,
  updateUserResultSchema,
} from '@asin-monitor/contracts';
import {
  BoundedAuthRepository,
  PgUserAdministrationRepository,
  type UserAdministrationRepositoryPort,
} from '@asin-monitor/db';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { PermissionCacheService } from '../src/auth/permission-cache.service';
import { PG_PERMISSION_GENERATION_KEY } from '../src/auth/postgres-permission-cache';
import { AppLogger } from '../src/logger/app-logger.service';
import { USER_ADMINISTRATION_REPOSITORY } from '../src/users/user-administration.service';
import { userAdministrationApp } from './helpers/user-administration-app';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'Neo user administration / real PostgreSQL and Redis',
  () => {
    let f: Awaited<ReturnType<typeof userAdministrationApp>>;
    let operatorId: string;
    let operatorSessionId: string;
    let headers: { authorization: string };
    let repository: UserAdministrationRepositoryPort;
    const admin = 'role-admin-61';
    const manager = 'role-manager-61';
    const reader = 'role-reader-61';
    beforeAll(async () => {
      f = await userAdministrationApp();
      repository = f.app.get(USER_ADMINISTRATION_REPOSITORY);
      expect(repository).toBeInstanceOf(PgUserAdministrationRepository);
    });
    afterAll(async () => {
      try {
        if (f) await f.close();
      } finally {
        vi.restoreAllMocks();
      }
    });
    async function seedUser(role = reader, username = `u61-${randomUUID()}`) {
      const id = randomUUID();
      f.userIds.add(id);
      await f.pools.primaryPool.query(
        "INSERT INTO users(id,username,password,force_password_change) VALUES($1,$2,'fixture-unused-hash',false)",
        [id, username],
      );
      await f.pools.primaryPool.query(
        'INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)',
        [id, role],
      );
      return id;
    }
    async function session(userId: string) {
      const id = randomUUID();
      await f.pools.primaryPool.query(
        "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,'2099-01-01 08:00:00')",
        [id, userId],
      );
      return id;
    }
    beforeEach(async () => {
      // The connection's search_path was checked by the helper. Only this file's
      // private schema contains these rows; no shared fixture administrator changes.
      await f.pools.primaryPool.query('UPDATE users SET status=$1', [
        'INACTIVE',
      ]);
      operatorId = await seedUser(admin);
      operatorSessionId = await session(operatorId);
      headers = {
        authorization: `Bearer ${jwt.sign(
          { userId: operatorId, sessionId: operatorSessionId },
          f.env.JWT_SECRET,
          { expiresIn: '1h' },
        )}`,
      };
    });
    const request = (
      method: 'POST' | 'PUT' | 'DELETE' | 'GET',
      path: string,
      payload?: object,
    ) => f.http.inject({ method, url: `/api/v1${path}`, headers, payload });
    const update = (id: string, body: object) =>
      request('PUT', `/users/${id}`, body);
    async function created(role = reader, username = `c61-${randomUUID()}`) {
      const response = await request('POST', '/users', {
        username,
        password: 'IntegrationPassword61',
        roleIds: [role],
      });
      expect(response.statusCode).toBe(200);
      const result = createUserResultSchema.parse(response.json()).data!;
      f.userIds.add(result.id);
      return { response, user: result };
    }
    const stored = async (id: string) =>
      (await f.pools.primaryPool.query('SELECT * FROM users WHERE id=$1', [id]))
        .rows[0];
    async function delegateOperator() {
      await f.pools.primaryPool.query(
        'UPDATE user_roles SET role_id=$1 WHERE user_id=$2',
        [manager, operatorId],
      );
    }

    it('creates a login-capable user with bcrypt, default policy, role links and sanitized audit', async () => {
      const result = await created();
      const row = await stored(result.user.id);
      expect(await bcrypt.compare('IntegrationPassword61', row.password)).toBe(
        true,
      );
      expect(row.password).not.toBe('IntegrationPassword61');
      expect(row.force_password_change).toBe(true);
      expect(
        row.password_expires_at.getTime() - row.password_changed_at.getTime(),
      ).toBe(90 * 86_400_000);
      expect(result.user.roles?.[0].id).toBe(reader);
      const login = await f.http.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: {
          username: result.user.username,
          password: 'IntegrationPassword61',
        },
      });
      expect(login.statusCode).toBe(200);
      expect(login.json().data.mustChangePassword).toBe(true);
      expect(
        (await request('GET', `/users/${result.user.id}`)).statusCode,
      ).toBe(200);
      await f.audit.flush();
      const entries = (
        await f.pools.primaryPool.query(
          "SELECT * FROM audit_logs WHERE user_id=$1 AND action='CREATE' AND resource='user'",
          [operatorId],
        )
      ).rows;
      expect(entries.some((entry) => entry.response_status === 200)).toBe(true);
      expect(JSON.stringify(entries)).not.toContain('IntegrationPassword61');
      expect(JSON.stringify(entries)).not.toContain(row.password);
      expect(result.response.body).not.toContain(row.password);
    });
    it('atomically changes status/history/sessions and invalidates role permissions for another cache instance', async () => {
      const target = await seedUser();
      const targetSession = await session(target);
      await f.pools.primaryPool.query(
        "UPDATE users SET failed_login_attempts=3,last_failed_login='2026-09-01 08:00:00',locked_until='2099-01-01 08:00:00' WHERE id=$1",
        [target],
      );
      expect(
        (
          await update(target, {
            status: 'ACTIVE',
            statusReason: 'fixture activation',
          })
        ).statusCode,
      ).toBe(200);
      let row = await stored(target);
      expect(row.failed_login_attempts).toBe(0);
      expect(row.last_failed_login).toBeNull();
      expect(row.locked_until).toBeNull();
      const otherCache = new PermissionCacheService(
        f.env,
        f.redis,
        new BoundedAuthRepository(f.pools.primaryPool),
        f.logger as unknown as AppLogger,
      );
      expect(await otherCache.getPermissions(target)).toEqual(['asin:read']);
      const changed = await update(target, {
        real_name: 'Fixture renamed',
        roleIds: [manager],
        status: 'SUSPENDED',
        statusReason: 'fixture suspension',
      });
      expect(changed.statusCode).toBe(200);
      expect(updateUserResultSchema.parse(changed.json()).data).toMatchObject({
        real_name: 'Fixture renamed',
        status: 'SUSPENDED',
      });
      row = await stored(target);
      expect(row.status).toBe('SUSPENDED');
      expect(
        (
          await f.pools.primaryPool.query(
            'SELECT status FROM sessions WHERE id=$1',
            [targetSession],
          )
        ).rows[0].status,
      ).toBe('REVOKED');
      expect(await otherCache.getPermissions(target)).toContain('user:write');
      const history = (
        await f.pools.primaryPool.query(
          'SELECT old_status,new_status,changed_by,created_at FROM user_status_history WHERE user_id=$1 ORDER BY id',
          [target],
        )
      ).rows;
      expect(history).toMatchObject([
        { old_status: 'LOCKED', new_status: 'ACTIVE', changed_by: operatorId },
        {
          old_status: 'ACTIVE',
          new_status: 'SUSPENDED',
          changed_by: operatorId,
        },
      ]);
      expect(history.every((entry) => entry.created_at instanceof Date)).toBe(
        true,
      );
    });
    it('rolls back user creation and all update side effects after an actual role-insert SQL failure', async () => {
      const generation = await f.redis.get(PG_PERMISSION_GENERATION_KEY);
      const rejected = await request('POST', '/users', {
        username: 'reject-role-61',
        password: 'IntegrationPassword61',
        roleIds: [reader],
      });
      expect(rejected.statusCode).toBe(500);
      expect(
        (
          await f.pools.primaryPool.query(
            'SELECT id FROM users WHERE username=$1',
            ['reject-role-61'],
          )
        ).rows,
      ).toEqual([]);
      const target = await seedUser();
      const targetSession = await session(target);
      await f.pools.primaryPool.query(
        'UPDATE users SET username=$1 WHERE id=$2',
        ['reject-role-61', target],
      );
      const response = await update(target, {
        real_name: 'Must roll back',
        status: 'SUSPENDED',
        roleIds: [manager],
      });
      expect(response.statusCode).toBe(500);
      expect(await stored(target)).toMatchObject({
        real_name: null,
        status: 'ACTIVE',
      });
      expect(
        (
          await f.pools.primaryPool.query(
            'SELECT role_id FROM user_roles WHERE user_id=$1',
            [target],
          )
        ).rows,
      ).toEqual([{ role_id: reader }]);
      expect(
        (
          await f.pools.primaryPool.query(
            'SELECT status FROM sessions WHERE id=$1',
            [targetSession],
          )
        ).rows[0].status,
      ).toBe('ACTIVE');
      expect(
        (
          await f.pools.primaryPool.query(
            'SELECT id FROM user_status_history WHERE user_id=$1',
            [target],
          )
        ).rows,
      ).toEqual([]);
      expect(await f.redis.get(PG_PERMISSION_GENERATION_KEY)).toBe(generation);
      expect(JSON.stringify(f.logger.error.mock.calls)).not.toContain(
        'fixture-private-role-failure',
      );
    });
    it('serializes concurrent changes so the final ACTIVE administrator cannot be removed', async () => {
      await delegateOperator();
      const first = await seedUser(admin);
      const second = await seedUser(admin);
      const responses = await Promise.all([
        update(first, { status: 'INACTIVE' }),
        update(second, { status: 'INACTIVE' }),
      ]);
      expect(responses.map((response) => response.statusCode).sort()).toEqual([
        200, 400,
      ]);
      expect(
        (
          await f.pools.primaryPool.query(
            "SELECT count(*)::int AS count FROM users u JOIN user_roles ur ON ur.user_id=u.id WHERE u.status='ACTIVE' AND ur.role_id=$1",
            [admin],
          )
        ).rows[0].count,
      ).toBe(1);
      const remaining =
        (await stored(first)).status === 'ACTIVE' ? first : second;
      expect((await request('DELETE', `/users/${remaining}`)).statusCode).toBe(
        400,
      );
      expect((await update(remaining, { roleIds: [reader] })).statusCode).toBe(
        400,
      );
    });
    it('recovers a real failed PostgreSQL statement with a savepoint and preserves the final administrator', async () => {
      await delegateOperator();
      const failed = await seedUser(admin, 'reject-delete-61');
      const deletedAdmin = await seedUser(admin);
      const deletedReader = await seedUser(reader);
      await session(deletedAdmin);
      await f.pools.primaryPool.query(
        "INSERT INTO password_history(user_id,password_hash) VALUES($1,'fixture-history')",
        [deletedAdmin],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO user_status_history(user_id,new_status) VALUES($1,'ACTIVE')",
        [deletedAdmin],
      );
      const response = await request('POST', '/users/batch-delete', {
        userIds: [
          failed,
          deletedAdmin,
          deletedReader,
          operatorId,
          'missing-user-61',
        ],
      });
      expect(response.statusCode).toBe(200);
      expect(batchDeleteResultSchema.parse(response.json()).data).toMatchObject(
        {
          totalRequested: 5,
          deletedCount: 2,
          failed: [{ userId: failed, message: '删除失败' }],
          skipped: [{ userId: operatorId }, { userId: 'missing-user-61' }],
        },
      );
      expect(await stored(failed)).toBeDefined();
      expect(await stored(deletedAdmin)).toBeUndefined();
      expect(await stored(deletedReader)).toBeUndefined();
      for (const table of [
        'sessions',
        'password_history',
        'user_status_history',
        'user_roles',
      ]) {
        expect(
          (
            await f.pools.primaryPool.query(
              `SELECT user_id FROM ${table} WHERE user_id=$1`,
              [deletedAdmin],
            )
          ).rows,
        ).toEqual([]);
      }
      expect(JSON.stringify(f.logger.error.mock.calls)).not.toContain(
        'fixture-private-delete-failure',
      );
    });
    it('rechecks revoked authority after the request waits for the administration lock', async () => {
      const target = await seedUser();
      const connection = await f.pools.primaryPool.connect();
      await connection.query('BEGIN');
      await connection.query(
        'SELECT pg_advisory_xact_lock(1095977294,1380073795)',
      );
      const spy = vi.spyOn(repository, 'transaction');
      const pending = update(target, { real_name: 'Must not commit' });
      try {
        await vi.waitFor(() => expect(spy).toHaveBeenCalled(), {
          timeout: 1000,
        });
        await connection.query('DELETE FROM user_roles WHERE user_id=$1', [
          operatorId,
        ]);
        await connection.query('COMMIT');
      } finally {
        await connection.query('ROLLBACK');
        connection.release();
        spy.mockRestore();
      }
      expect((await pending).statusCode).toBe(403);
      expect((await stored(target)).real_name).toBeNull();
    });
    it('does not execute a delayed write after the database lock timeout', async () => {
      const target = await seedUser();
      const connection = await f.pools.primaryPool.connect();
      await connection.query('BEGIN');
      await connection.query(
        'SELECT pg_advisory_xact_lock(1095977294,1380073795)',
      );
      try {
        expect(
          (await update(target, { real_name: 'Late write' })).statusCode,
        ).toBe(500);
      } finally {
        await connection.query('ROLLBACK');
        connection.release();
      }
      expect((await stored(target)).real_name).toBeNull();
      expect(
        (await update(target, { real_name: 'After recovery' })).statusCode,
      ).toBe(200);
    });
  },
);
