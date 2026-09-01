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
import { AuthRepository, LegacyMysqlSessionRepository } from '@asin-monitor/db';
import {
  AUTH_DATA_REPOSITORY,
  AUTH_SESSION_REPOSITORY,
} from '../src/auth/auth.constants';
import { AuthController } from '../src/auth/auth.controller';
import { createAuthSessionRepository } from '../src/auth/auth.module';
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
    it('双跑期使用实时 MySQL Session 权威状态并复用 PG/Redis RBAC', async () => {
      const env = loadEnv(process.env);
      const logger = new AppLogger();
      const pools = new ApplicationDatabasePools(env, logger);
      const redis = new ApplicationRedisClient(env, logger);
      const repository = new AuthRepository(pools.primaryDb);
      const mysqlPool = mysql.createPool({
        host: env.DB_HOST!,
        port: env.DB_PORT,
        user: env.DB_USER!,
        password: env.DB_PASSWORD!,
        database: env.DB_NAME!,
        timezone: '+08:00',
      });
      const sessionRepository = createAuthSessionRepository(
        env,
        repository,
        logger,
      );
      let app: NestFastifyApplication | undefined;

      try {
        expect(env.AUTH_SESSION_AUTHORITY).toBe('legacy-mysql');
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
        await mysqlPool.query('DELETE FROM sessions WHERE id = ?', [sessionId]);
        await mysqlPool.query(
          `INSERT INTO sessions (id, user_id, expires_at)
           VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR))`,
          [sessionId, userId],
        );
        await pools.primaryPool.query('DELETE FROM users WHERE id = $1', [
          userId,
        ]);
        await pools.primaryPool.query('DELETE FROM roles WHERE id = $1', [
          roleId,
        ]);
        await pools.primaryPool.query(
          `INSERT INTO users (id, username, password, real_name, status, force_password_change)
         VALUES ($1, $2, $3, $4, 'ACTIVE', false)`,
          [userId, 'neo-auth-integration', 'unused-hash', 'Integration User'],
        );
        await pools.primaryPool.query(
          `INSERT INTO roles (id, code, name) VALUES ($1, $2, $3)`,
          [roleId, 'neo-integration-role', 'Neo integration role'],
        );
        await pools.primaryPool.query(
          'INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)',
          [userId, roleId],
        );
        await pools.primaryPool.query(
          'INSERT INTO role_permissions (role_id, permission_id) VALUES ($1, $2)',
          [roleId, permissionId],
        );
        await redis.del(`user:permissions:${userId}`, `user:roles:${userId}`);

        const moduleRef = await Test.createTestingModule({
          controllers: [AuthController, AuthIntegrationController],
          providers: [
            { provide: ENV, useValue: env },
            { provide: AUTH_DATA_REPOSITORY, useValue: repository },
            { provide: AUTH_SESSION_REPOSITORY, useValue: sessionRepository },
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
        const pgSession = await pools.primaryPool.query<{ count: string }>(
          'SELECT count(*)::text AS count FROM sessions WHERE id = $1',
          [sessionId],
        );
        expect(pgSession.rows[0]?.count).toBe('0');
        const [touchedRows] = await mysqlPool.query<
          (RowDataPacket & { active: number })[]
        >(
          'SELECT last_active_at >= created_at AS active FROM sessions WHERE id = ?',
          [sessionId],
        );
        expect(touchedRows[0]?.active).toBe(1);

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
        if (sessionRepository instanceof LegacyMysqlSessionRepository) {
          await sessionRepository.onModuleDestroy();
        }
        await mysqlPool.query('DELETE FROM sessions WHERE id = ?', [sessionId]);
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
        await pools.onModuleDestroy();
      }
    }, 30_000);
  },
);
