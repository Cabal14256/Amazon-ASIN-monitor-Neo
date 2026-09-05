import { loadEnv } from '@asin-monitor/config';
import {
  currentUserResultSchema,
  loginResultSchema,
} from '@asin-monitor/contracts';
import type { LoginRepositoryPort, LoginUnit } from '@asin-monitor/db';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuthModule } from '../src/auth/auth.module';
import { LOGIN_REPOSITORY } from '../src/auth/login.service';
import { ENV } from '../src/config/config.module';
import { ApplicationDatabasePools } from '../src/database/database.service';
import { configureHttpApp } from '../src/http-app';
import { AppLogger } from '../src/logger/app-logger.service';
import { ApplicationRedisClient } from '../src/redis/redis.service';

const enabled = process.env.RUN_INTEGRATION_TESTS === 'true';
describe.skipIf(!enabled)('Neo login / real PostgreSQL', () => {
  let app: NestFastifyApplication;
  let pools: ApplicationDatabasePools;
  let repo: LoginRepositoryPort;
  const prefix = `nl${randomUUID().replace(/-/g, '')}`;
  const usernames: string[] = [];
  const userIds: string[] = [];
  const password = 'Fixture-Login-Password-31';
  let passwordHash: string;
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
    fatal: vi.fn(),
    verbose: vi.fn(),
  } as unknown as AppLogger;
  const selectedEnv = () => ({
    ...loadEnv(process.env),
    AUTH_DATA_AUTHORITY: 'postgresql' as const,
  });
  beforeAll(async () => {
    passwordHash = await bcrypt.hash(password, 10);
    pools = new ApplicationDatabasePools(selectedEnv(), logger);
    const module = await Test.createTestingModule({ imports: [AuthModule] })
      .overrideProvider(ENV)
      .useValue(selectedEnv())
      .overrideProvider(AppLogger)
      .useValue(logger)
      .overrideProvider(ApplicationDatabasePools)
      .useValue(pools)
      .overrideProvider(ApplicationRedisClient)
      .useValue({
        get: async () => null,
        setex: async () => undefined,
        del: async () => 0,
      })
      .compile();
    app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
      { logger: false },
    );
    configureHttpApp(app, { logger });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    repo = app.get(LOGIN_REPOSITORY);
  }, 15000);
  afterAll(async () => {
    vi.restoreAllMocks();
    try {
      if (pools) {
        if (userIds.length)
          await pools.primaryPool.query(
            'DELETE FROM users WHERE id = ANY($1::text[])',
            [userIds],
          );
        if (usernames.length)
          await pools.primaryPool.query(
            'DELETE FROM login_attempts WHERE lower(username) = ANY($1::text[])',
            [usernames.map((name) => name.toLowerCase())],
          );
      }
    } finally {
      if (app) await app.close();
      else if (pools) await pools.onModuleDestroy();
    }
  });
  async function user(
    label: string,
    options: { failed?: number; expiredPassword?: boolean } = {},
  ) {
    const id = `${prefix}-${label}`;
    userIds.push(id);
    usernames.push(id);
    await pools.primaryPool.query(
      `INSERT INTO users (id, username, password, failed_login_attempts, password_expires_at)
      VALUES ($1, $1, $2, $3, $4)`,
      [
        id,
        passwordHash,
        options.failed ?? 0,
        options.expiredPassword ? '2000-01-01 00:00:00' : null,
      ],
    );
    return id;
  }
  const login = (
    username: string,
    suppliedPassword = password,
    rememberMe = false,
  ) =>
    app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username, password: suppliedPassword, rememberMe },
      });
  it('creates a usable session atomically and matches username case without exposing the hash', async () => {
    const username = await user('case');
    const response = await login(username.toUpperCase());
    expect(response.statusCode).toBe(200);
    const data = loginResultSchema.parse(response.json()).data!;
    const claims = jwt.verify(
      data.token,
      selectedEnv().JWT_SECRET,
    ) as jwt.JwtPayload;
    const session = (
      await pools.primaryPool.query('SELECT * FROM sessions WHERE id=$1', [
        data.sessionId,
      ])
    ).rows[0];
    expect(session.user_id).toBe(username);
    expect(session.status).toBe('ACTIVE');
    expect(session.remember_me).toBe(false);
    expect(new Date(session.expires_at).getTime()).toBe(claims.exp! * 1000);
    expect(claims.exp! - claims.iat!).toBe(7 * 86400);
    const current = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/api/v1/auth/current-user',
        headers: { authorization: `Bearer ${data.token}` },
      });
    expect(current.statusCode).toBe(200);
    expect(currentUserResultSchema.parse(current.json()).data?.user.id).toBe(
      username,
    );
    expect(response.body).not.toContain(passwordHash);
    // Raw database wall time must remain authoritative on the Drizzle auth read
    // path too: a one-hour-expired session cannot gain eight extra hours.
    await pools.primaryPool.query(
      "UPDATE sessions SET expires_at=LOCALTIMESTAMP - INTERVAL '1 hour' WHERE id=$1",
      [data.sessionId],
    );
    const expired = await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method: 'GET',
        url: '/api/v1/auth/current-user',
        headers: { authorization: `Bearer ${data.token}` },
      });
    expect(expired.statusCode).toBe(401);
    const updated = (
      await pools.primaryPool.query(
        'SELECT last_login_time, failed_login_attempts FROM users WHERE id=$1',
        [username],
      )
    ).rows[0];
    expect(updated.last_login_time).not.toBeNull();
    expect(
      Math.abs(new Date(updated.last_login_time).getTime() - Date.now()),
    ).toBeLessThan(5000);
    expect(updated.failed_login_attempts).toBe(0);
    expect(
      (
        await pools.primaryPool.query(
          'SELECT success FROM login_attempts WHERE lower(username)=$1',
          [username],
        )
      ).rows,
    ).toEqual([{ success: true }]);
  });
  it('remember-me TTL and expired-password flag persist consistently', async () => {
    const username = await user('remember', { expiredPassword: true });
    const response = await login(username, password, true);
    expect(response.statusCode).toBe(200);
    const data = loginResultSchema.parse(response.json()).data!;
    expect(data.mustChangePassword).toBe(true);
    expect(data.passwordExpired).toBe(true);
    const claims = jwt.decode(data.token) as jwt.JwtPayload;
    expect(claims.exp! - claims.iat!).toBe(30 * 86400);
    expect(
      (
        await pools.primaryPool.query(
          'SELECT remember_me FROM sessions WHERE id=$1',
          [data.sessionId],
        )
      ).rows[0].remember_me,
    ).toBe(true);
    expect(
      (
        await pools.primaryPool.query(
          'SELECT force_password_change FROM users WHERE id=$1',
          [username],
        )
      ).rows[0].force_password_change,
    ).toBe(true);
  });
  it('serializes five concurrent failures with a user row lock, then rejects even correct credentials', async () => {
    const username = await user('lock');
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => login(username, 'wrong')),
    );
    expect(responses.map((response) => response.statusCode)).toEqual([
      401, 401, 401, 401, 401,
    ]);
    const locked = (
      await pools.primaryPool.query(
        'SELECT status, failed_login_attempts, locked_until FROM users WHERE id=$1',
        [username],
      )
    ).rows[0];
    expect(locked.status).toBe('LOCKED');
    expect(locked.failed_login_attempts).toBe(5);
    expect(
      new Date(locked.locked_until).getTime() - Date.now(),
    ).toBeGreaterThan(29 * 60000);
    expect((await login(username)).statusCode).toBe(423);
    expect(
      Number(
        (
          await pools.primaryPool.query(
            'SELECT count(*) AS count FROM login_attempts WHERE username=$1',
            [username],
          )
        ).rows[0].count,
      ),
    ).toBe(5);
    expect(
      Number(
        (
          await pools.primaryPool.query(
            'SELECT count(*) AS count FROM sessions WHERE user_id=$1',
            [username],
          )
        ).rows[0].count,
      ),
    ).toBe(0);
  });
  it('rolls back user info, attempts and an already inserted session if later work fails', async () => {
    const username = await user('rollback', { failed: 3 });
    const original = repo.transaction.bind(repo);
    vi.spyOn(repo, 'transaction').mockImplementationOnce((callback) =>
      original((unit) => {
        const wrapper = new Proxy(unit, {
          get(target, key) {
            if (key === 'createSession')
              return async (
                session: Parameters<LoginUnit['createSession']>[0],
              ) => {
                await target.createSession(session);
                throw new Error('fixture private post-insert failure');
              };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        return callback(wrapper);
      }),
    );
    const response = await login(username);
    expect(response.statusCode).toBe(500);
    expect(response.cookies).toEqual([]);
    const unchanged = (
      await pools.primaryPool.query(
        'SELECT last_login_time, failed_login_attempts FROM users WHERE id=$1',
        [username],
      )
    ).rows[0];
    expect(unchanged).toEqual({
      last_login_time: null,
      failed_login_attempts: 3,
    });
    expect(
      Number(
        (
          await pools.primaryPool.query(
            'SELECT count(*) AS count FROM sessions WHERE user_id=$1',
            [username],
          )
        ).rows[0].count,
      ),
    ).toBe(0);
    expect(
      Number(
        (
          await pools.primaryPool.query(
            'SELECT count(*) AS count FROM login_attempts WHERE username=$1',
            [username],
          )
        ).rows[0].count,
      ),
    ).toBe(0);
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(
      'fixture private post-insert failure',
    );
  });
  it('cancels blocked login SQL within its deadline and does not leave a session or cookie', async () => {
    const username = await user('timeout');
    const blocker = await pools.primaryPool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [
        username,
      ]);
      const started = Date.now();
      const response = await login(username);
      expect(response.statusCode).toBe(500);
      expect(response.cookies).toEqual([]);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    expect(
      Number(
        (
          await pools.primaryPool.query(
            'SELECT count(*) AS count FROM sessions WHERE user_id=$1',
            [username],
          )
        ).rows[0].count,
      ),
    ).toBe(0);
    expect(
      (await pools.primaryPool.query('SHOW statement_timeout')).rows[0]
        .statement_timeout,
    ).toBe('0');
  }, 10000);
});
