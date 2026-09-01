import { Controller, Get, UseGuards } from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadEnv, type Env } from '@asin-monitor/config';
import { currentUserResultSchema } from '@asin-monitor/contracts';
import type {
  AuthDataRepository,
  AuthSessionRecord,
  AuthUserRecord,
} from '@asin-monitor/db';
import { AUTH_DATA_REPOSITORY } from '../src/auth/auth.constants';
import { AuthController } from '../src/auth/auth.controller';
import { AuthenticationGuard } from '../src/auth/authentication.guard';
import { AuthenticationService } from '../src/auth/authentication.service';
import { PermissionCacheService } from '../src/auth/permission-cache.service';
import { PermissionsGuard } from '../src/auth/permissions.guard';
import { RequirePermissions } from '../src/auth/require-permissions.decorator';
import { ENV } from '../src/config/config.module';
import { configureHttpApp } from '../src/http-app';
import { AppLogger } from '../src/logger/app-logger.service';
import { ApplicationRedisClient } from '../src/redis/redis.service';

const env = loadEnv({
  DATABASE_URL: 'postgresql://localhost/amazon_asin_monitor',
  COMPETITOR_DATABASE_URL: 'postgresql://localhost/amazon_competitor_monitor',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'test-secret',
});

const activeSession: AuthSessionRecord = {
  id: '00000000-0000-0000-0000-000000000019',
  userId: 'user-19',
  userAgent: null,
  ipAddress: null,
  status: 'ACTIVE',
  rememberMe: false,
  createdAt: new Date('2026-09-01T00:00:00.000Z'),
  lastActiveAt: new Date('2026-09-01T00:00:00.000Z'),
  expiresAt: new Date('2099-01-01T00:00:00.000Z'),
};

const activeUser: AuthUserRecord = {
  id: 'user-19',
  username: 'neo-user',
  realName: 'Neo User',
  status: 'ACTIVE',
  lastLoginTime: new Date('2026-09-01T01:00:00.000Z'),
  lastLoginIp: '127.0.0.1',
  passwordExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
  passwordChangedAt: new Date('2026-08-01T00:00:00.000Z'),
  forcePasswordChange: false,
  failedLoginAttempts: 0,
  lockedUntil: null,
  createTime: new Date('2026-01-01T00:00:00.000Z'),
  updateTime: new Date('2026-09-01T00:00:00.000Z'),
};

function createRepositoryMock(): AuthDataRepository {
  return {
    findSessionById: vi.fn().mockResolvedValue(activeSession),
    revokeSession: vi.fn().mockResolvedValue(undefined),
    touchSession: vi.fn().mockResolvedValue(undefined),
    findUserById: vi.fn().mockResolvedValue(activeUser),
    markPasswordChangeRequired: vi.fn().mockResolvedValue(undefined),
    getPermissionCodes: vi.fn().mockResolvedValue(['asin:read']),
    getRoleCodes: vi.fn().mockResolvedValue(['operator']),
  };
}

function createRedisMock(): ApplicationRedisClient {
  return {
    get: vi.fn().mockResolvedValue(null),
    setex: vi.fn().mockResolvedValue(undefined),
    del: vi.fn().mockResolvedValue(0),
    ping: vi.fn().mockResolvedValue(undefined),
  } as unknown as ApplicationRedisClient;
}

function token(
  claims: Record<string, unknown> = {
    userId: activeUser.id,
    sessionId: activeSession.id,
  },
  options: jwt.SignOptions = { expiresIn: '1h' },
): string {
  return jwt.sign(claims, env.JWT_SECRET, options);
}

@Controller('rbac-test')
@UseGuards(AuthenticationGuard, PermissionsGuard)
class RbacTestController {
  @Get('read')
  @RequirePermissions('asin:read')
  read(): { success: true } {
    return { success: true };
  }

  @Get('write')
  @RequirePermissions('asin:write')
  write(): { success: true } {
    return { success: true };
  }
}

describe('Neo JWT/Session HTTP 鉴权与 RBAC', () => {
  let app: NestFastifyApplication;
  let repository: AuthDataRepository;
  let redis: ApplicationRedisClient;
  let logger: AppLogger;

  beforeEach(async () => {
    repository = createRepositoryMock();
    redis = createRedisMock();
    logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as AppLogger;
    const moduleRef = await Test.createTestingModule({
      controllers: [AuthController, RbacTestController],
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
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it('未提供 token 返回 legacy 401 信封且不清理 Cookie', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/api/v1/auth/current-user',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({
      success: false,
      errorMessage: '未提供认证令牌',
      errorCode: 401,
    });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('Cookie 优先于 Bearer，成功返回契约并触碰会话', async () => {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/api/v1/auth/current-user',
        headers: {
          cookie: `${env.AUTH_COOKIE_NAME}=${token()}`,
          authorization: 'Bearer invalid-bearer',
        },
      });

    expect(response.statusCode).toBe(200);
    expect(currentUserResultSchema.parse(response.json())).toMatchObject({
      success: true,
      errorCode: 0,
      data: {
        sessionId: activeSession.id,
        permissions: ['asin:read'],
        roles: ['operator'],
        passwordExpired: false,
        mustChangePassword: false,
        user: {
          id: activeUser.id,
          username: activeUser.username,
          status: 'ACTIVE',
          force_password_change: false,
        },
      },
    });
    expect(repository.touchSession).toHaveBeenCalledWith(activeSession.id);
  });

  it('无 Cookie 时兼容 Bearer，且重复 /api 前缀不命中路由', async () => {
    const fastify = app.getHttpAdapter().getInstance();
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/v1/auth/current-user',
      headers: { authorization: `Bearer ${token()}` },
    });
    const duplicated = await fastify.inject({
      method: 'GET',
      url: '/api/v1/api/v1/auth/current-user',
      headers: { authorization: `Bearer ${token()}` },
    });

    expect(response.statusCode).toBe(200);
    expect(duplicated.statusCode).toBe(404);
  });

  it.each([
    {
      label: '过期 JWT',
      authToken: () => token(undefined, { expiresIn: -1 }),
      status: 401,
      message: '认证令牌已过期',
    },
    {
      label: '非法 JWT',
      authToken: () => 'not-a-jwt',
      status: 403,
      message: '无效的认证令牌',
    },
    {
      label: '尚未生效 JWT',
      authToken: () => token(undefined, { notBefore: '1h', expiresIn: '2h' }),
      status: 403,
      message: '无效的认证令牌',
    },
    {
      label: '缺少会话声明',
      authToken: () => token({ userId: activeUser.id }),
      status: 403,
      message: '无效的认证令牌',
    },
  ])('$label 返回固定信封并清理两个 Cookie', async (scenario) => {
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/api/v1/auth/current-user',
        headers: { authorization: `Bearer ${scenario.authToken()}` },
      });

    expect(response.statusCode).toBe(scenario.status);
    expect(response.json()).toEqual({
      success: false,
      errorMessage: scenario.message,
      errorCode: scenario.status,
    });
    const cookies = response.headers['set-cookie'];
    expect(cookies).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`${env.AUTH_COOKIE_NAME}=`),
        expect.stringContaining(`${env.AUTH_HINT_COOKIE_NAME}=`),
      ]),
    );
  });

  it.each([
    {
      label: '会话不存在',
      session: undefined,
      status: 401,
      message: '会话不存在或已过期',
    },
    {
      label: '会话用户不匹配',
      session: { ...activeSession, userId: 'another-user' },
      status: 403,
      message: '会话已失效',
    },
    {
      label: '会话已撤销',
      session: { ...activeSession, status: 'REVOKED' },
      status: 403,
      message: '会话已失效',
    },
  ])('$label 被拒绝', async (scenario) => {
    vi.mocked(repository.findSessionById).mockResolvedValueOnce(
      scenario.session,
    );
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/api/v1/auth/current-user',
        headers: { authorization: `Bearer ${token()}` },
      });

    expect(response.statusCode).toBe(scenario.status);
    expect(response.json()).toMatchObject({
      errorMessage: scenario.message,
      errorCode: scenario.status,
    });
  });

  it('过期会话先标记 REVOKED 再返回 401', async () => {
    vi.mocked(repository.findSessionById).mockResolvedValueOnce({
      ...activeSession,
      expiresAt: new Date('2000-01-01T00:00:00.000Z'),
    });
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/api/v1/auth/current-user',
        headers: { authorization: `Bearer ${token()}` },
      });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ errorMessage: '会话已过期' });
    expect(repository.revokeSession).toHaveBeenCalledWith(activeSession.id);
    expect(repository.touchSession).not.toHaveBeenCalled();
  });

  it.each([
    ['INACTIVE', null, '用户已被禁用'],
    ['SUSPENDED', null, '用户已被停用'],
    ['PENDING', null, '账户待激活'],
    ['ACTIVE', new Date('2099-01-01T00:00:00.000Z'), '账户已锁定'],
  ] as const)(
    '非活跃用户状态 %s 返回 legacy 403',
    async (status, locked, message) => {
      vi.mocked(repository.findUserById).mockResolvedValueOnce({
        ...activeUser,
        status,
        lockedUntil: locked,
      });
      const response = await app
        .getHttpAdapter()
        .getInstance()
        .inject({
          method: 'GET',
          url: '/api/v1/auth/current-user',
          headers: { authorization: `Bearer ${token()}` },
        });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ errorMessage: message });
    },
  );

  it('密码到期时持久化强制改密并在响应中同步标记', async () => {
    vi.mocked(repository.findUserById).mockResolvedValueOnce({
      ...activeUser,
      passwordExpiresAt: new Date('2000-01-01T00:00:00.000Z'),
    });
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/api/v1/auth/current-user',
        headers: { authorization: `Bearer ${token()}` },
      });

    expect(response.json()).toMatchObject({
      data: {
        passwordExpired: true,
        mustChangePassword: true,
        user: { force_password_change: true },
      },
    });
    expect(repository.markPasswordChangeRequired).toHaveBeenCalledWith(
      activeUser.id,
    );
  });

  it('RBAC Guard 允许完整权限并拒绝缺失权限', async () => {
    const fastify = app.getHttpAdapter().getInstance();
    const headers = { authorization: `Bearer ${token()}` };
    const allowed = await fastify.inject({
      method: 'GET',
      url: '/api/v1/rbac-test/read',
      headers,
    });
    const denied = await fastify.inject({
      method: 'GET',
      url: '/api/v1/rbac-test/write',
      headers,
    });

    expect(allowed.statusCode).toBe(200);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).toEqual({
      success: false,
      errorMessage: '没有权限执行此操作',
      errorCode: 403,
    });
  });

  it('依赖异常只记录固定上下文并返回脱敏 503', async () => {
    vi.mocked(repository.findSessionById).mockRejectedValueOnce(
      new Error('postgresql://operator:raw-secret@db.internal/primary'),
    );
    const response = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/api/v1/auth/current-user',
        headers: { authorization: `Bearer ${token()}` },
      });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      success: false,
      errorMessage: '服务器内部错误',
      errorCode: 503,
    });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(
      'raw-secret',
    );
  });
});

describe('PermissionCacheService', () => {
  let repository: AuthDataRepository;
  let redis: ApplicationRedisClient;
  let logger: AppLogger;

  beforeEach(() => {
    repository = createRepositoryMock();
    redis = createRedisMock();
    logger = {
      warn: vi.fn(),
    } as unknown as AppLogger;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function cache(customEnv: Env = env): PermissionCacheService {
    return new PermissionCacheService(customEnv, redis, repository, logger);
  }

  it('优先读取合法 Redis 权限缓存而不访问数据库', async () => {
    vi.mocked(redis.get).mockResolvedValueOnce('["asin:write"]');

    await expect(cache().getPermissions(activeUser.id)).resolves.toEqual([
      'asin:write',
    ]);
    expect(repository.getPermissionCodes).not.toHaveBeenCalled();
  });

  it('Redis 不可用时查询数据库并用独立 TTL 内存缓存降级', async () => {
    vi.mocked(redis.get).mockRejectedValue(new Error('redis down'));
    vi.mocked(redis.setex).mockRejectedValue(new Error('redis down'));
    const service = cache();

    await expect(service.getPermissions(activeUser.id)).resolves.toEqual([
      'asin:read',
    ]);
    await expect(service.getPermissions(activeUser.id)).resolves.toEqual([
      'asin:read',
    ]);
    expect(repository.getPermissionCodes).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('无效 Redis JSON 不进入缓存，并可按用户精确清理两个键', async () => {
    vi.mocked(redis.get).mockResolvedValueOnce('["unknown:permission"]');
    const service = cache();

    await expect(service.getPermissions(activeUser.id)).resolves.toEqual([
      'asin:read',
    ]);
    await service.clearUserCache(activeUser.id);

    expect(redis.del).toHaveBeenCalledWith(
      `user:permissions:${activeUser.id}`,
      `user:roles:${activeUser.id}`,
    );
  });
});
