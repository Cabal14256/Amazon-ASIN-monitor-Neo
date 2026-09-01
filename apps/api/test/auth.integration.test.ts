import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';

import { loadEnv } from '@asin-monitor/config';
import { currentUserResultSchema } from '@asin-monitor/contracts';
import { AuthRepository } from '@asin-monitor/db';
import { AUTH_DATA_REPOSITORY } from '../src/auth/auth.constants';
import { AuthController } from '../src/auth/auth.controller';
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
  'Neo Auth PostgreSQL/Redis integration',
  () => {
    it('共享连接池、真实 Session/RBAC 表与 Redis 缓存贯通 HTTP 请求', async () => {
      const env = loadEnv(process.env);
      const logger = new AppLogger();
      const pools = new ApplicationDatabasePools(env, logger);
      const redis = new ApplicationRedisClient(env, logger);
      const repository = new AuthRepository(pools.primaryDb);
      let app: NestFastifyApplication | undefined;

      try {
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
        await pools.primaryPool.query(
          `INSERT INTO sessions (id, user_id, expires_at)
         VALUES ($1, $2, LOCALTIMESTAMP + interval '1 hour')`,
          [sessionId, userId],
        );
        await redis.del(
          `user:permissions:${userId}`,
          `neo:user:roles:${userId}`,
        );

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
        const touched = await pools.primaryPool.query<{ active: boolean }>(
          'SELECT last_active_at >= created_at AS active FROM sessions WHERE id = $1',
          [sessionId],
        );
        expect(touched.rows[0]?.active).toBe(true);
      } finally {
        if (redis.client.status !== 'end') {
          await redis.del(
            `user:permissions:${userId}`,
            `neo:user:roles:${userId}`,
          );
        }
        if (app) await app.close();
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
