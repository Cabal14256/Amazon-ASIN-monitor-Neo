import { loadEnv, type Env } from '@asin-monitor/config';
import { loginResultSchema } from '@asin-monitor/contracts';
import type {
  LoginRepositoryPort,
  LoginUnit,
  LoginUserRecord,
} from '@asin-monitor/db';
import { HttpException } from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginController } from '../src/auth/login.controller';
import {
  comparePassword,
  LOGIN_REPOSITORY,
  LoginService,
  PASSWORD_COMPARER,
  tokenLifetimeSeconds,
} from '../src/auth/login.service';
import { ENV } from '../src/config/config.module';
import { configureHttpApp } from '../src/http-app';
import { AppLogger } from '../src/logger/app-logger.service';

const env = loadEnv({
  DATABASE_URL: 'postgresql://localhost/primary',
  COMPETITOR_DATABASE_URL: 'postgresql://localhost/competitor',
  REDIS_URL: 'redis://localhost:6379',
  JWT_SECRET: 'fixture-secret',
  AUTH_DATA_AUTHORITY: 'postgresql',
});
const input = { username: 'fixture-user', password: 'Fixture-Password-019' };
function fixture(overrides: Partial<Env> = {}) {
  let user: LoginUserRecord | undefined = {
    id: 'login-fixture',
    username: input.username,
    password: 'fixture-hash',
    realName: 'Fixture Name',
    status: 'ACTIVE',
    lastLoginTime: null,
    lastLoginIp: null,
    passwordExpiresAt: null,
    passwordChangedAt: null,
    forcePasswordChange: false,
    failedLoginAttempts: 0,
    lockedUntil: null,
    lastFailedLogin: null,
    createTime: new Date('2026-01-01T00:00:00Z'),
    updateTime: new Date('2026-01-01T00:00:00Z'),
  };
  const unit: LoginUnit = {
    lockUser: vi.fn(async () => (user ? structuredClone(user) : undefined)),
    updateUser: vi.fn(async (_id, patch) => {
      if (user) Object.assign(user, patch);
    }),
    recordAttempt: vi.fn(async () => undefined),
    createSession: vi.fn(async () => undefined),
    access: vi.fn(async () => ({
      permissions: ['asin:read'],
      roles: [{ id: 'role-fixture', code: 'operator', name: 'Operator' }],
    })),
  };
  const repository: LoginRepositoryPort = {
    transaction: vi.fn(async (callback) => callback(unit)),
  };
  const compare = vi.fn(async (password) => password === input.password);
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  } as unknown as AppLogger;
  const selectedEnv = { ...env, ...overrides };
  const service = new LoginService(selectedEnv, repository, compare, logger);
  return {
    unit,
    repository,
    compare,
    logger,
    service,
    env: selectedEnv,
    get user() {
      return user!;
    },
    missing() {
      user = undefined;
    },
  };
}
const client = { ip: '192.0.2.50', userAgent: 'Fixture client' };
const apps: NestFastifyApplication[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});
async function http(
  f: ReturnType<typeof fixture>,
  onActor?: (actor: unknown) => void,
) {
  const module = await Test.createTestingModule({
    controllers: [LoginController],
    providers: [
      LoginService,
      { provide: ENV, useValue: f.env },
      { provide: LOGIN_REPOSITORY, useValue: f.repository },
      { provide: PASSWORD_COMPARER, useValue: f.compare },
      { provide: AppLogger, useValue: f.logger },
    ],
  }).compile();
  const app = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
    { logger: false },
  );
  configureHttpApp(app, { logger: f.logger });
  if (onActor)
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onResponse', async (request) => {
        onActor(request.auth);
      });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  apps.push(app);
  return app.getHttpAdapter().getInstance();
}
async function expectStatus(
  promise: Promise<unknown>,
  status: number,
  message?: string,
) {
  try {
    await promise;
    throw new Error('Expected HTTP failure');
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(status);
    if (message)
      expect((error as HttpException).getResponse()).toMatchObject({
        errorMessage: message,
      });
  }
}
describe('Neo login domain', () => {
  it.each([false, true])(
    'issues compatible signed session and cookies (rememberMe=%s)',
    async (rememberMe) => {
      const f = fixture();
      let actor: unknown;
      const server = await http(f, (value) => {
        actor = value;
      });
      const response = await server.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { ...input, rememberMe },
      });
      expect(response.statusCode).toBe(200);
      const result = loginResultSchema.parse(response.json());
      const data = result.data!;
      const claims = jwt.verify(data.token, env.JWT_SECRET, {
        algorithms: ['HS256'],
      }) as jwt.JwtPayload;
      expect(claims).toMatchObject({
        userId: f.user.id,
        sessionId: data.sessionId,
      });
      expect(claims.exp! - claims.iat!).toBe((rememberMe ? 30 : 7) * 86400);
      expect(data).toMatchObject({
        roles: ['operator'],
        permissions: ['asin:read'],
        mustChangePassword: false,
        passwordExpired: false,
      });
      expect(JSON.stringify(result)).not.toContain('fixture-hash');
      expect(actor).toMatchObject({
        userId: f.user.id,
        sessionId: data.sessionId,
      });
      expect(JSON.stringify(actor)).not.toContain('fixture-hash');
      const session = vi.mocked(f.unit.createSession).mock.calls[0]![0];
      expect(session.expiresAt?.getTime()).toBe(claims.exp! * 1000);
      expect(session.rememberMe).toBe(rememberMe);
      const cookies = response.cookies;
      const auth = cookies.find(
        (cookie) => cookie.name === env.AUTH_COOKIE_NAME,
      )!;
      const hint = cookies.find(
        (cookie) => cookie.name === env.AUTH_HINT_COOKIE_NAME,
      )!;
      expect(auth.httpOnly).toBe(true);
      expect(hint.httpOnly).not.toBe(true);
      expect(auth.sameSite).toBe('Lax');
      expect(auth.path).toBe('/');
      expect(hint.value).toBe('1');
      expect(auth.maxAge).toBeGreaterThan((rememberMe ? 30 : 7) * 86400 - 5);
      expect(auth.maxAge).toBeLessThanOrEqual((rememberMe ? 30 : 7) * 86400);
    },
  );
  it('forces Secure in production and does not trust a direct spoofed forwarded-proto header', async () => {
    const production = fixture({ NODE_ENV: 'production' });
    const secure = await (
      await http(production)
    ).inject({ method: 'POST', url: '/api/v1/auth/login', payload: input });
    expect(secure.cookies[0]?.secure).toBe(true);
    const local = await (
      await http(fixture())
    ).inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: input,
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(local.cookies[0]?.secure).not.toBe(true);
  });
  it('rejects foreign origins before verification while configured origin works', async () => {
    const f = fixture();
    const server = await http(f);
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: input,
          headers: { origin: 'https://foreign.invalid' },
        })
      ).statusCode,
    ).toBe(403);
    expect(f.compare).not.toHaveBeenCalled();
    expect(
      (
        await server.inject({
          method: 'POST',
          url: '/api/v1/auth/login',
          payload: input,
          headers: { origin: env.CORS_ORIGIN },
        })
      ).statusCode,
    ).toBe(200);
  });
  it.each([
    {},
    null,
    { username: 'x' },
    { ...input, password: {} },
    { ...input, rememberMe: 'true' },
    { ...input, username: 'x'.repeat(51) },
    { ...input, password: 'x'.repeat(1025) },
  ])(
    'rejects malformed login without database access (%j)',
    async (payload) => {
      const f = fixture();
      await expectStatus(
        f.service.login(payload, client),
        400,
        '用户名和密码不能为空',
      );
      expect(f.repository.transaction).not.toHaveBeenCalled();
    },
  );
  it('does not write PG while Legacy MySQL is authoritative', async () => {
    const f = fixture({ AUTH_DATA_AUTHORITY: 'legacy-mysql' });
    await expectStatus(f.service.login(input, client), 503);
    expect(f.repository.transaction).not.toHaveBeenCalled();
    expect(f.compare).not.toHaveBeenCalled();
  });
  it('unknown users perform one dummy comparison and record failed attempts, never sessions', async () => {
    const f = fixture();
    f.missing();
    await expectStatus(f.service.login(input, client), 401, '用户名或密码错误');
    expect(f.compare).toHaveBeenCalledOnce();
    expect(f.unit.recordAttempt).toHaveBeenCalledWith(
      input.username,
      client.ip,
      false,
    );
    expect(f.unit.createSession).not.toHaveBeenCalled();
  });
  it('five wrong passwords lock for thirty minutes; the sixth request does not verify again', async () => {
    const f = fixture();
    const before = Date.now();
    for (let index = 0; index < 5; index++)
      await expectStatus(
        f.service.login({ ...input, password: 'wrong' }, client),
        401,
      );
    expect(f.user.status).toBe('LOCKED');
    expect(f.user.failedLoginAttempts).toBe(5);
    expect(f.user.lockedUntil!.getTime()).toBeGreaterThanOrEqual(
      before + 30 * 60000,
    );
    await expectStatus(f.service.login(input, client), 423);
    expect(f.compare).toHaveBeenCalledTimes(5);
    expect(f.unit.recordAttempt).toHaveBeenCalledTimes(5);
  });
  it('expired locks reset counters and allow login, without reactivating a suspended account', async () => {
    const f = fixture();
    Object.assign(f.user, {
      status: 'LOCKED',
      failedLoginAttempts: 5,
      lockedUntil: new Date(0),
    });
    expect((await f.service.login(input, client)).data.user.status).toBe(
      'ACTIVE',
    );
    expect(f.user.failedLoginAttempts).toBe(0);
    expect(f.user.lockedUntil).toBeNull();
    const suspended = fixture();
    Object.assign(suspended.user, {
      status: 'SUSPENDED',
      lockedUntil: new Date(0),
    });
    await expectStatus(
      suspended.service.login(input, client),
      403,
      '用户已被停用',
    );
    expect(suspended.user.status).toBe('SUSPENDED');
    expect(suspended.compare).not.toHaveBeenCalled();
  });
  it.each(['LOCKED', 'INACTIVE', 'SUSPENDED', 'PENDING'])(
    'does not issue a session for %s users',
    async (status) => {
      const f = fixture();
      f.user.status = status;
      await expectStatus(
        f.service.login(input, client),
        status === 'LOCKED' ? 423 : 403,
      );
      expect(f.unit.createSession).not.toHaveBeenCalled();
      expect(f.compare).not.toHaveBeenCalled();
    },
  );
  it('password expiry preserves legacy login success with a force-change flag', async () => {
    const f = fixture();
    f.user.passwordExpiresAt = new Date(0);
    expect((await f.service.login(input, client)).data).toMatchObject({
      mustChangePassword: true,
      passwordExpired: true,
      user: { force_password_change: true },
    });
    expect(f.user.forcePasswordChange).toBe(true);
  });
  it('never sets cookies before commit and masks persistence errors and credentials in logs', async () => {
    const f = fixture();
    let finish!: (value: never) => void;
    vi.mocked(f.repository.transaction).mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          finish = reject;
        }),
    );
    const server = await http(f);
    const response = server.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: input,
    });
    await vi.waitFor(() => expect(f.repository.transaction).toHaveBeenCalled());
    finish(
      new Error(
        'private connection postgres://user:secret@host payload',
      ) as never,
    );
    const result = await response;
    expect(result.statusCode).toBe(500);
    expect(result.cookies).toEqual([]);
    const logs = JSON.stringify(vi.mocked(f.logger.error).mock.calls);
    for (const secret of [
      'private connection',
      'secret@host',
      input.username,
      input.password,
    ])
      expect(logs).not.toContain(secret);
    expect(result.body).not.toContain('private connection');
  });
  it('bounds concurrent expensive work and releases capacity on failure', async () => {
    const f = fixture();
    const rejectors: Array<(error: Error) => void> = [];
    vi.mocked(f.repository.transaction).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectors.push(reject);
        }),
    );
    const operations = Array.from({ length: 8 }, () =>
      f.service.login(input, client).catch((error) => error),
    );
    await expectStatus(f.service.login(input, client), 429);
    expect(f.repository.transaction).toHaveBeenCalledTimes(8);
    rejectors.forEach((reject) => reject(new Error('fixture')));
    await Promise.all(operations);
    vi.mocked(f.repository.transaction).mockImplementation(async (callback) =>
      callback(f.unit),
    );
    expect((await f.service.login(input, client)).data.user.id).toBe(f.user.id);
  });
  it('supports the legacy bcrypt cost-10 hash without accepting a wrong password', async () => {
    const hash = await bcrypt.hash(input.password, 10);
    expect(await comparePassword(input.password, hash)).toBe(true);
    expect(await comparePassword('wrong', hash)).toBe(false);
    await expect(
      comparePassword(input.password, hash.replace('$10$', '$31$')),
    ).rejects.toThrow('Unsupported password hash configuration');
  });
  it('holds real comparison capacity after the containing transactions time out', async () => {
    const f = fixture();
    f.user.password =
      '$2b$10$qZJ9My6tPcAWAYNmlFbfoOESfqFNt1lov4Gjv6eru7.rE8KItdn.m';
    const rejectors: Array<(error: Error) => void> = [];
    const compare = vi.spyOn(bcrypt, 'compare').mockImplementation(
      () =>
        new Promise<boolean>((_resolve, reject) => {
          rejectors.push(reject);
        }),
    );
    const callbacks: Promise<unknown>[] = [];
    vi.mocked(f.repository.transaction).mockImplementation((operation) => {
      const work = operation(f.unit);
      callbacks.push(work);
      return Promise.race([
        work,
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error('fixture transaction deadline')),
            5,
          ),
        ),
      ]);
    });
    const service = new LoginService(
      f.env,
      f.repository,
      comparePassword,
      f.logger,
    );
    try {
      // Request admission slots have been released, but bcrypt is still running.
      await Promise.all(
        Array.from({ length: 8 }, () =>
          expectStatus(service.login(input, client), 500),
        ),
      );
      await expectStatus(service.login(input, client), 429);
      expect(compare).toHaveBeenCalledTimes(8);
      expect(f.unit.createSession).not.toHaveBeenCalled();
    } finally {
      rejectors.forEach((reject) =>
        reject(new Error('fixture computation ended')),
      );
      await Promise.allSettled(callbacks);
    }
    vi.mocked(f.repository.transaction).mockImplementation((operation) =>
      operation(f.unit),
    );
    compare.mockImplementation(async () => true);
    expect((await service.login(input, client)).data.user.id).toBe(f.user.id);
  });
  it('JWT seconds, ms, week/year units are finite and nonzero before DB writes', () => {
    expect(tokenLifetimeSeconds('2h')).toBe(7200);
    expect(tokenLifetimeSeconds('1000ms')).toBe(1);
    expect(tokenLifetimeSeconds('1w')).toBe(604800);
    expect(tokenLifetimeSeconds('1y')).toBe(31557600);
    for (const value of [
      '0s',
      '1ms',
      '-1s',
      '9999999999999999999999y',
      'bogus',
    ])
      expect(() => tokenLifetimeSeconds(value)).toThrow();
  });
});
