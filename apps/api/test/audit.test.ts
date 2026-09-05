import { loadEnv } from '@asin-monitor/config';
import type { AuditRepositoryPort } from '@asin-monitor/db';
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Injectable,
  Post,
  Put,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module';
import { auditBody } from '../src/audit/audit-data';
import { auditAction } from '../src/audit/audit-mapping';
import { AuditInterceptor } from '../src/audit/audit.interceptor';
import { AUDIT_REPOSITORY, AuditService } from '../src/audit/audit.service';
import { ENV } from '../src/config/config.module';
import { configureHttpApp } from '../src/http-app';
import { AppLogger } from '../src/logger/app-logger.service';

const validEnv = loadEnv({
  DATABASE_URL: 'postgresql://localhost/amazon_asin_monitor',
  COMPETITOR_DATABASE_URL: 'postgresql://localhost/amazon_competitor_monitor',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'test-secret',
  AUTH_DATA_AUTHORITY: 'postgresql',
});
const logger = () =>
  ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as AppLogger);

describe('audit mapping and data', () => {
  it.each([
    ['POST', '/auth/login', 'LOGIN', 'auth'],
    ['POST', '/auth/logout', 'LOGOUT', 'auth'],
    ['POST', '/auth/change-password', 'CHANGE_PASSWORD', 'auth'],
    ['PUT', '/auth/profile', 'UPDATE_PROFILE', 'auth'],
    ['POST', '/auth/sessions/revoke', 'REVOKE_SESSION', 'auth'],
    ['POST', '/variant-groups', 'CREATE', 'variant_group'],
    ['POST', '/variant-groups/batch-delete', 'BATCH_DELETE', 'variant_group'],
    ['POST', '/competitor/asins/batch-create', 'BATCH_CREATE', 'asin'],
    ['PUT', '/asins/:asinId', 'UPDATE', 'asin'],
    ['DELETE', '/variant-groups/:groupId', 'DELETE', 'variant_group'],
    ['POST', '/users/batch-delete', 'BATCH_DELETE', 'user'],
    ['PUT', '/users/:userId/password', 'RESET_PASSWORD', 'user'],
    ['PUT', '/roles/:roleId/permissions', 'UPDATE_ROLE_PERMISSIONS', 'role'],
    ['POST', '/roles', 'POST', 'role'],
    ['POST', '/permissions', 'POST', 'permission'],
    ['POST', '/feishu-configs', 'UPDATE', 'feishu_config'],
    ['PUT', '/sp-api-configs', 'UPDATE', 'sp_api_config'],
    ['GET', '/export/asin', 'EXPORT', 'asin'],
    ['GET', '/export/monitor-history', 'EXPORT', 'monitor_history'],
    ['POST', '/tasks/export', 'EXPORT', 'unknown'],
    ['POST', '/competitor/monitor/trigger', 'TRIGGER_MONITOR', 'monitor'],
  ])('%s %s retains action %s', (method, path, action, resource) => {
    expect(auditAction(method, `/api/v1${path}`)).toMatchObject({
      action,
      resource,
    });
  });

  it('resource ids/names retain legacy fields, read-only and unrelated paths are excluded', () => {
    expect(
      auditAction(
        'PUT',
        '/api/v1/asins/:asinId',
        { asinId: 'a-1' },
        { asin: 'B012345678' },
      ),
    ).toMatchObject({ resourceId: 'a-1', resourceName: 'B012345678' });
    expect(
      auditAction('DELETE', '/api/v1/users/:userId', { userId: 'abcdefghij' }),
    ).toMatchObject({
      resourceId: 'abcdefghij',
      resourceName: '用户 abcdefgh...',
    });
    for (const path of [
      '/users',
      '/roles/:roleId/permissions',
      '/auth/profile',
      '/asins',
    ]) {
      expect(auditAction('GET', `/api/v1${path}`)).toBeUndefined();
    }
    expect(auditAction('POST', '/api/v1/not-asins')).toBeUndefined();
    expect(auditAction('POST', '/api/v1/constructor')).toBeUndefined();
    expect(auditAction('POST', '/api/v1/__proto__')).toBeUndefined();
    expect(auditAction('POST', '/api/v1/api/v1/users')).toBeUndefined();
    expect(auditAction('OPTIONS', '/api/v1/users')).toBeUndefined();
    expect(auditAction('HEAD', '/api/v1/export/asin')).toBeUndefined();
  });

  it('nested credentials are masked without mutating input; cycles and large uploads are bounded', () => {
    const input = {
      password: 'top-secret',
      nested: {
        'api-key': 'key-secret',
        items: [{ refreshToken: 'token-secret' }],
      },
      webhookUrl: 'url-secret',
      safe: 'name',
    };
    const encoded = JSON.stringify(auditBody(input));
    for (const secret of [
      'top-secret',
      'key-secret',
      'token-secret',
      'url-secret',
    ])
      expect(encoded).not.toContain(secret);
    expect(input.password).toBe('top-secret');
    expect(encoded).toContain('name');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(auditBody(cyclic)).toEqual({ self: '[omitted]' });
    const large = Object.fromEntries(
      Array.from({ length: 500 }, (_, i) => [`field${i}`, '中'.repeat(2000)]),
    );
    expect(
      Buffer.byteLength(JSON.stringify(auditBody(large))),
    ).toBeLessThanOrEqual(16_384);
  });

  it('masks config values independently of companion keys and recursively excludes personal fields', () => {
    const data = auditBody({
      configs: [
        {
          configKey: 'SP_API_US_REFRESH_TOKEN',
          configValue: 'refresh-credential',
        },
        { configKey: 'SP_API_CLIENT_SECRET', configValue: 'client-credential' },
        { configKey: 'AWS_ACCESS_KEY_ID', configValue: 'aws-credential' },
        {
          config_key: 'NEW_CREDENTIAL_KIND',
          config_value: 'future-credential',
        },
        { configKey: 'NEW_NAME', displayValue: 'display-credential' },
      ],
      real_name: 'personal-name',
      statusReason: 'personal-reason',
      nested: {
        email: 'person@example.invalid',
        phone: 'personal-phone',
        realName: 'nested-person',
      },
    });
    const serialized = JSON.stringify(data);
    for (const raw of [
      'refresh-credential',
      'client-credential',
      'aws-credential',
      'future-credential',
      'display-credential',
      'personal-name',
      'personal-reason',
      'person@example.invalid',
      'personal-phone',
      'nested-person',
    ])
      expect(serialized).not.toContain(raw);
    expect(serialized).toContain('SP_API_US_REFRESH_TOKEN');
  });
});

@Injectable()
class AuditFixtureGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (request.headers.authorization !== 'Bearer fixture')
      throw new UnauthorizedException();
    request.auth = {
      userId: 'actor-23',
      sessionId: 'session-23',
      user: { username: 'audit-user' },
    } as FastifyRequest['auth'];
    if ((request.body as { denied?: boolean })?.denied)
      throw new ForbiddenException();
    return true;
  }
}

@Controller()
class AuditFixtureController {
  @Post('auth/login')
  @HttpCode(200)
  login() {
    return { success: false, errorMessage: 'arbitrary secret from provider' };
  }

  @Post('variant-groups')
  @UseGuards(AuditFixtureGuard)
  async create(@Body() body: Record<string, unknown>) {
    body.name = 'mutated by handler';
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { success: true, data: { id: 'new-group' } };
  }

  @Put('users/:userId')
  @UseGuards(AuditFixtureGuard)
  async update() {
    await new Promise<void>((resolve) => setImmediate(resolve));
    throw new ForbiddenException({ success: false, errorMessage: 'rejected' });
  }

  @Post('users')
  createUser(@Req() _request: FastifyRequest) {
    return { success: true };
  }

  @Post('sp-api-configs')
  configs() {
    return { success: true };
  }

  @Put('auth/profile')
  profile() {
    return { success: true };
  }

  @Get('export/asin')
  export(@Res() reply: FastifyReply) {
    return reply.type('text/csv').send(Readable.from(['asin\nB012345678\n']));
  }

  @Get('users')
  list() {
    return { success: true, data: [] };
  }
}

describe('Neo audit HTTP lifecycle', () => {
  let app: NestFastifyApplication;
  let repository: AuditRepositoryPort;
  let audit: AuditService;
  let log: AppLogger;

  async function setup(trustProxy?: boolean | number | string) {
    repository = { append: vi.fn().mockResolvedValue(undefined) };
    log = logger();
    const moduleRef = await Test.createTestingModule({
      controllers: [AuditFixtureController],
      providers: [
        AuditService,
        AuditFixtureGuard,
        { provide: AUDIT_REPOSITORY, useValue: repository },
        { provide: AppLogger, useValue: log },
        { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
      ],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({
        logger: false,
        ...(trustProxy === undefined ? {} : { trustProxy }),
      }),
    );
    audit = moduleRef.get(AuditService);
    configureHttpApp(app, { audit, logger: log });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  }

  beforeEach(() => setup());

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it('uses authenticated actor, immutable redacted body and final status, ignoring spoofed proxy headers', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/variant-groups?token=query-secret',
      remoteAddress: '198.51.100.23',
      headers: {
        authorization: 'Bearer fixture',
        'x-forwarded-for': '1.2.3.4',
        'x-real-ip': '5.6.7.8',
      },
      payload: {
        name: 'original',
        password: 'raw-password',
        nested: { refreshToken: 'raw-token' },
        userId: 'spoofed-user',
      },
    });
    await audit.flush();
    expect(response.statusCode).toBe(201);
    expect(repository.append).toHaveBeenCalledOnce();
    expect(repository.append).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CREATE',
        resource: 'variant_group',
        resourceName: 'original',
        userId: 'actor-23',
        username: 'audit-user',
        responseStatus: 201,
        path: '/api/v1/variant-groups',
        ipAddress: '198.51.100.23',
        errorMessage: null,
        requestData: expect.objectContaining({
          name: 'original',
          password: '***REDACTED***',
        }),
      }),
    );
    const encoded = JSON.stringify(vi.mocked(repository.append).mock.calls);
    for (const secret of ['raw-password', 'raw-token', 'query-secret'])
      expect(encoded).not.toContain(secret);
  });

  it('records controller and Guard failures once with their final status and trusted identity only', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/v1/users/u-1',
      headers: { authorization: 'Bearer fixture' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/variant-groups',
      payload: { username: 'spoofed' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/variant-groups',
      headers: { authorization: 'Bearer fixture' },
      payload: { denied: true },
    });
    await audit.flush();
    expect(
      vi
        .mocked(repository.append)
        .mock.calls.map(([entry]) => [
          entry.responseStatus,
          entry.userId,
          entry.username,
        ]),
    ).toEqual([
      [403, 'actor-23', 'audit-user'],
      [401, null, null],
      [403, 'actor-23', 'audit-user'],
    ]);
    expect(vi.mocked(repository.append).mock.calls[0]![0]).toMatchObject({
      resourceId: 'u-1',
      errorMessage: '操作失败',
    });
  });

  it('keeps SP-API credentials and personal profile fields out of persisted HTTP snapshots', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/v1/sp-api-configs',
      payload: {
        configs: [
          { configKey: 'SP_API_US_REFRESH_TOKEN', configValue: 'http-secret' },
          { configKey: 'AWS_ACCESS_KEY_ID', configValue: 'aws-secret' },
        ],
      },
    });
    await app.inject({
      method: 'PUT',
      url: '/api/v1/auth/profile',
      payload: { real_name: 'private-name', statusReason: 'private-reason' },
    });
    await audit.flush();
    expect(repository.append).toHaveBeenCalledTimes(2);
    const saved = JSON.stringify(vi.mocked(repository.append).mock.calls);
    for (const raw of [
      'http-secret',
      'aws-secret',
      'private-name',
      'private-reason',
    ])
      expect(saved).not.toContain(raw);
    expect(saved).toContain('***REDACTED***');
  });

  it('uses forwarded client IP only when the immediate peer matches configured trusted proxies', async () => {
    await app.close();
    const configured = loadEnv({
      DATABASE_URL: 'postgres://localhost/primary',
      COMPETITOR_DATABASE_URL: 'postgres://localhost/competitor',
      REDIS_URL: 'redis://localhost:6379',
      JWT_SECRET: 'test-secret',
      AUTH_DATA_AUTHORITY: 'postgresql',
      TRUST_PROXY: 'loopback',
    });
    await setup(configured.TRUST_PROXY);
    for (const remoteAddress of ['127.0.0.1', '203.0.113.42']) {
      await app.inject({
        method: 'POST',
        url: '/api/v1/users',
        remoteAddress,
        headers: { 'x-forwarded-for': '198.51.100.23' },
      });
    }
    await audit.flush();
    expect(
      vi.mocked(repository.append).mock.calls.map(([entry]) => entry.ipAddress),
    ).toEqual(['198.51.100.23', '203.0.113.42']);
  });

  it('captures login failure envelopes and parser failures without copying error payload secrets', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { username: 'attempted-user', password: 'never-store' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      headers: { 'content-type': 'application/json' },
      payload: '{',
    });
    await audit.flush();
    expect(login.statusCode).toBe(200);
    expect(vi.mocked(repository.append).mock.calls[0]![0]).toMatchObject({
      action: 'LOGIN',
      username: 'attempted-user',
      userId: null,
      responseStatus: 200,
      errorMessage: '操作失败',
    });
    expect(vi.mocked(repository.append).mock.calls[1]![0].responseStatus).toBe(
      400,
    );
    expect(
      JSON.stringify(vi.mocked(repository.append).mock.calls),
    ).not.toContain('arbitrary secret');
  });

  it('streams exports intact, ignores normal reads and unknown API paths', async () => {
    const exported = await app.inject({
      method: 'GET',
      url: '/api/v1/export/asin',
    });
    await app.inject({ method: 'GET', url: '/api/v1/users' });
    await app.inject({ method: 'POST', url: '/api/v1/not-asins' });
    await app.inject({ method: 'POST', url: '/api/v1/api/v1/users' });
    await audit.flush();
    expect(exported.body).toBe('asin\nB012345678\n');
    expect(repository.append).toHaveBeenCalledOnce();
    expect(repository.append).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'EXPORT', responseStatus: 200 }),
    );
  });

  it('a failed audit write never changes the business response or logs repository payloads', async () => {
    vi.mocked(repository.append).mockRejectedValueOnce(
      new Error('postgresql://user:password@host/db actor@example.com'),
    );
    const response = await app.inject({ method: 'POST', url: '/api/v1/users' });
    await audit.flush();
    expect(response.statusCode).toBe(201);
    expect(log.error).toHaveBeenCalledWith('操作审计写入失败', 'AuditService', {
      reason: 'audit_write_failed',
    });
  });

  it('caps pending persistence and resumes after outstanding writes complete', async () => {
    let complete!: () => void;
    const blocked = new Promise<void>((resolve) => {
      complete = resolve;
    });
    vi.mocked(repository.append).mockReturnValue(blocked);
    for (let index = 0; index < 300; index += 1)
      audit.record({ action: 'CREATE', resource: 'asin' });
    await Promise.resolve();
    expect(repository.append).toHaveBeenCalledTimes(256);
    expect(log.warn).toHaveBeenCalledOnce();
    complete();
    await audit.flush();
    audit.record({ action: 'CREATE', resource: 'asin' });
    await audit.flush();
    expect(repository.append).toHaveBeenCalledTimes(257);
  });
});

it('AppModule resolves audit and its PostgreSQL repository', async () => {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENV)
    .useValue(validEnv)
    .overrideProvider(AppLogger)
    .useValue(logger())
    .compile();
  expect(moduleRef.get(AuditService)).toBeInstanceOf(AuditService);
  expect(moduleRef.get(AUDIT_REPOSITORY)).toHaveProperty('append');
  await moduleRef.close();
});
