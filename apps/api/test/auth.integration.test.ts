import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import jwt from 'jsonwebtoken';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';

import { loadEnv } from '@asin-monitor/config';
import { currentUserResultSchema } from '@asin-monitor/contracts';
import { LegacyMysqlAuthRepository } from '@asin-monitor/db';
import { AUTH_DATA_REPOSITORY } from '../src/auth/auth.constants';
import { AuthController } from '../src/auth/auth.controller';
import { createAuthDataRepository } from '../src/auth/auth.module';
import { AuthenticationGuard } from '../src/auth/authentication.guard';
import { AuthenticationService } from '../src/auth/authentication.service';
import { PermissionCacheService } from '../src/auth/permission-cache.service';
import { PermissionsGuard } from '../src/auth/permissions.guard';
import { RequirePermissions } from '../src/auth/require-permissions.decorator';
import { ENV } from '../src/config/config.module';
import { ApplicationDatabasePools } from '../src/database/database.service';
import { configureHttpApp } from '../src/http-app';
import { AppLogger } from '../src/logger/app-logger.service';
import { ApplicationRedisClient } from '../src/redis/redis.service';

const integrationEnabled = process.env.RUN_INTEGRATION_TESTS === 'true';
const userId = 'neo-auth-integration-user';
const sessionId = '00000000-0000-0000-0000-000000000119';
const roleId = 'neo-auth-integration-role';
const permissionId = 'perm-001';

@Controller('auth-integration')
@UseGuards(AuthenticationGuard, PermissionsGuard)
class AuthIntegrationController {
  @Get('allowed')
  @RequirePermissions('asin:read')
  allowed(): { success: true } {
    return { success: true };
  }
}

describe.skipIf(!integrationEnabled)(
  'Neo Auth PostgreSQL/Redis/Legacy MySQL integration',
  () => {
    it('双跑期全部鉴权数据使用实时 MySQL 权威源，PG 快照不参与授权', async () => {
      const env = loadEnv(process.env);
      const logger = new AppLogger();
      const pools = new ApplicationDatabasePools(env, logger);
      const redis = new ApplicationRedisClient(env, logger);
      const mysqlPool = mysql.createPool({
        host: env.DB_HOST!,
        port: env.DB_PORT,
        user: env.DB_USER!,
        password: env.DB_PASSWORD!,
        database: env.DB_NAME!,
        timezone: '+08:00',
      });
      const repository = createAuthDataRepository(env, pools, logger);
      let app: NestFastifyApplication | undefined;

      try {
        expect(env.AUTH_DATA_AUTHORITY).toBe('legacy-mysql');
        await mysqlPool.query(`CREATE TABLE IF NOT EXISTS users (
          id VARCHAR(50) PRIMARY KEY,
          username VARCHAR(50) NOT NULL,
          password VARCHAR(255) NOT NULL,
          real_name VARCHAR(100) NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
          last_login_time DATETIME NULL,
          last_login_ip VARCHAR(50) NULL,
          password_expires_at DATETIME NULL,
          password_changed_at DATETIME NULL,
          force_password_change TINYINT(1) NULL DEFAULT 0,
          failed_login_attempts INT NULL DEFAULT 0,
          locked_until DATETIME NULL,
          create_time DATETIME NULL,
          update_time DATETIME NULL
        )`);
        await mysqlPool.query(`CREATE TABLE IF NOT EXISTS sessions (
          id CHAR(36) PRIMARY KEY,
          user_id VARCHAR(50) NOT NULL,
          user_agent VARCHAR(255) NULL,
          ip_address VARCHAR(64) NULL,
          status VARCHAR(7) NOT NULL DEFAULT 'ACTIVE',
          remember_me TINYINT(1) NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_active_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          expires_at DATETIME NULL
        )`);
        await mysqlPool.query(`CREATE TABLE IF NOT EXISTS roles (
          id VARCHAR(50) PRIMARY KEY,
          code VARCHAR(50) NOT NULL,
          name VARCHAR(100) NOT NULL
        )`);
        await mysqlPool.query(`CREATE TABLE IF NOT EXISTS permissions (
          id VARCHAR(50) PRIMARY KEY,
          code VARCHAR(50) NOT NULL
        )`);
        await mysqlPool.query(`CREATE TABLE IF NOT EXISTS user_roles (
          user_id VARCHAR(50) NOT NULL,
          role_id VARCHAR(50) NOT NULL,
          UNIQUE KEY uq_user_role (user_id, role_id)
        )`);
        await mysqlPool.query(`CREATE TABLE IF NOT EXISTS role_permissions (
          role_id VARCHAR(50) NOT NULL,
          permission_id VARCHAR(50) NOT NULL,
          UNIQUE KEY uq_role_permission (role_id, permission_id)
        )`);

        await mysqlPool.query('DELETE FROM user_roles WHERE user_id = ?', [
          userId,
        ]);
        await mysqlPool.query(
          'DELETE FROM role_permissions WHERE role_id = ?',
          [roleId],
        );
        await mysqlPool.query('DELETE FROM sessions WHERE id = ?', [sessionId]);
        await mysqlPool.query('DELETE FROM users WHERE id = ?', [userId]);
        await mysqlPool.query('DELETE FROM roles WHERE id = ?', [roleId]);
        await mysqlPool.query('DELETE FROM permissions WHERE id = ?', [
          permissionId,
        ]);
        await mysqlPool.query(
          `INSERT INTO users (
             id, username, password, real_name, status,
             password_expires_at, password_changed_at,
             force_password_change, failed_login_attempts,
             create_time, update_time
           ) VALUES (
             ?, ?, ?, ?, 'ACTIVE',
             UTC_TIMESTAMP() + INTERVAL 9 HOUR,
             UTC_TIMESTAMP() + INTERVAL 8 HOUR,
             0, 0,
             UTC_TIMESTAMP() + INTERVAL 8 HOUR,
             UTC_TIMESTAMP() + INTERVAL 8 HOUR
           )`,
          [userId, 'neo-auth-integration', 'unused-hash', 'Integration User'],
        );
        await mysqlPool.query(
          'INSERT INTO roles (id, code, name) VALUES (?, ?, ?)',
          [roleId, 'neo-integration-role', 'Neo integration role'],
        );
        await mysqlPool.query(
          'INSERT INTO permissions (id, code) VALUES (?, ?)',
          [permissionId, 'asin:read'],
        );
        await mysqlPool.query(
          'INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)',
          [userId, roleId],
        );
        await mysqlPool.query(
          'INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)',
          [roleId, permissionId],
        );
        await mysqlPool.query(
          `INSERT INTO sessions (
             id, user_id, created_at, last_active_at, expires_at
           ) VALUES (
             ?, ?,
             UTC_TIMESTAMP() + INTERVAL 8 HOUR,
             UTC_TIMESTAMP() + INTERVAL 8 HOUR,
             UTC_TIMESTAMP() + INTERVAL 9 HOUR
           )`,
          [sessionId, userId],
        );
        await pools.primaryPool.query('DELETE FROM users WHERE id = $1', [
          userId,
        ]);
        await pools.primaryPool.query('DELETE FROM roles WHERE id = $1', [
          roleId,
        ]);
        await redis.del(`user:permissions:${userId}`, `user:roles:${userId}`);

        const moduleRef = await Test.createTestingModule({
          controllers: [AuthController, AuthIntegrationController],
          providers: [
            { provide: ENV, useValue: env },
            { provide: AUTH_DATA_REPOSITORY, useValue: repository },
            { provide: ApplicationRedisClient, useValue: redis },
            { provide: AppLogger, useValue: logger },
            AuthenticationService,
            AuthenticationGuard,
            PermissionCacheService,
            PermissionsGuard,
          ],
        }).compile();
        app = moduleRef.createNestApplication<NestFastifyApplication>(
          new FastifyAdapter({ logger: false }),
        );
        configureHttpApp(app, { logger });
        await app.init();
        await app.getHttpAdapter().getInstance().ready();

        const authToken = jwt.sign({ userId, sessionId }, env.JWT_SECRET, {
          algorithm: 'HS256',
          expiresIn: '1h',
        });
        const fastify = app.getHttpAdapter().getInstance();
        const currentUser = await fastify.inject({
          method: 'GET',
          url: '/api/v1/auth/current-user',
          headers: { authorization: `Bearer ${authToken}` },
        });
        const protectedRoute = await fastify.inject({
          method: 'GET',
          url: '/api/v1/auth-integration/allowed',
          headers: { authorization: `Bearer ${authToken}` },
        });

        expect(currentUser.statusCode).toBe(200);
        expect(currentUserResultSchema.parse(currentUser.json())).toMatchObject(
          {
            data: {
              sessionId,
              permissions: ['asin:read'],
              roles: ['neo-integration-role'],
              user: { id: userId, status: 'ACTIVE' },
            },
          },
        );
        expect(protectedRoute.statusCode).toBe(200);
        await expect(redis.get(`user:permissions:${userId}`)).resolves.toBe(
          '["asin:read"]',
        );
        const pgAuthorityRows = await pools.primaryPool.query<{
          sessions: string;
          users: string;
        }>(
          `SELECT
             (SELECT count(*) FROM sessions WHERE id = $1)::text AS sessions,
             (SELECT count(*) FROM users WHERE id = $2)::text AS users`,
          [sessionId, userId],
        );
        expect(pgAuthorityRows.rows[0]).toEqual({ sessions: '0', users: '0' });
        const [touchedRows] = await mysqlPool.query<
          (RowDataPacket & { active: number })[]
        >(
          'SELECT last_active_at >= created_at AS active FROM sessions WHERE id = ?',
          [sessionId],
        );
        expect(touchedRows[0]?.active).toBe(1);

        await mysqlPool.query(
          `UPDATE users
              SET password_expires_at = UTC_TIMESTAMP() + INTERVAL 7 HOUR,
                  force_password_change = 0
            WHERE id = ?`,
          [userId],
        );
        const passwordPolicy = await fastify.inject({
          method: 'GET',
          url: '/api/v1/auth/current-user',
          headers: { authorization: `Bearer ${authToken}` },
        });
        expect(passwordPolicy.statusCode).toBe(200);
        expect(passwordPolicy.json()).toMatchObject({
          data: { mustChangePassword: true, passwordExpired: true },
        });
        const [passwordRows] = await mysqlPool.query<
          (RowDataPacket & { required: number })[]
        >('SELECT force_password_change AS required FROM users WHERE id = ?', [
          userId,
        ]);
        expect(passwordRows[0]?.required).toBe(1);

        await mysqlPool.query('DELETE FROM user_roles WHERE user_id = ?', [
          userId,
        ]);
        await redis.del(`user:permissions:${userId}`, `user:roles:${userId}`);
        const revokedPermission = await fastify.inject({
          method: 'GET',
          url: '/api/v1/auth-integration/allowed',
          headers: { authorization: `Bearer ${authToken}` },
        });
        expect(revokedPermission.statusCode).toBe(403);
        expect(revokedPermission.json()).toMatchObject({
          errorMessage: '没有权限执行此操作',
        });

        await mysqlPool.query(
          "UPDATE users SET status = 'SUSPENDED' WHERE id = ?",
          [userId],
        );
        const suspended = await fastify.inject({
          method: 'GET',
          url: '/api/v1/auth/current-user',
          headers: { authorization: `Bearer ${authToken}` },
        });
        expect(suspended.statusCode).toBe(403);
        expect(suspended.json()).toMatchObject({
          errorMessage: '用户已被停用',
        });

        await mysqlPool.query(
          "UPDATE users SET status = 'ACTIVE' WHERE id = ?",
          [userId],
        );
        await mysqlPool.query(
          "UPDATE sessions SET status = 'REVOKED' WHERE id = ?",
          [sessionId],
        );
        const revoked = await fastify.inject({
          method: 'GET',
          url: '/api/v1/auth/current-user',
          headers: { authorization: `Bearer ${authToken}` },
        });
        expect(revoked.statusCode).toBe(403);
        expect(revoked.json()).toMatchObject({ errorMessage: '会话已失效' });
      } finally {
        if (redis.client.status !== 'end') {
          await redis.del(`user:permissions:${userId}`, `user:roles:${userId}`);
        }
        if (app) await app.close();
        if (repository instanceof LegacyMysqlAuthRepository) {
          await repository.onModuleDestroy();
        }
        await mysqlPool.query('DELETE FROM user_roles WHERE user_id = ?', [
          userId,
        ]);
        await mysqlPool.query(
          'DELETE FROM role_permissions WHERE role_id = ?',
          [roleId],
        );
        await mysqlPool.query('DELETE FROM sessions WHERE id = ?', [sessionId]);
        await mysqlPool.query('DELETE FROM users WHERE id = ?', [userId]);
        await mysqlPool.query('DELETE FROM roles WHERE id = ?', [roleId]);
        await mysqlPool.query('DELETE FROM permissions WHERE id = ?', [
          permissionId,
        ]);
        await mysqlPool.end();
        await pools.primaryPool.query('DELETE FROM users WHERE id = $1', [
          userId,
        ]);
        await pools.primaryPool.query('DELETE FROM roles WHERE id = $1', [
          roleId,
        ]);
        if (redis.client.status !== 'end') {
          redis.onModuleDestroy();
        }
        await pools.onApplicationShutdown();
      }
    }, 30_000);
  },
);
