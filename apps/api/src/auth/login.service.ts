import type { Env } from '@asin-monitor/config';
import {
  loginRequestSchema,
  type LoginData,
  type LoginRequest,
} from '@asin-monitor/contracts';
import type { LoginRepositoryPort, LoginUnit } from '@asin-monitor/db';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import { publicUser } from './auth.controller';
import type { AuthPrincipal } from './auth.types';
import {
  normalizeUserStatus,
  userStatusMessage,
} from './authentication.service';

export const LOGIN_REPOSITORY = Symbol('LOGIN_REPOSITORY');
export const PASSWORD_COMPARER = Symbol('PASSWORD_COMPARER');
export type PasswordComparer = (
  password: string,
  hash: string,
) => Promise<boolean>;
export const comparePassword: PasswordComparer = async (password, hash) => {
  const rounds = bcrypt.getRounds(hash);
  // Legacy hashes use cost 10. Reject corrupt/unbounded work factors before CPU work.
  if (!Number.isInteger(rounds) || rounds < 4 || rounds > 12) {
    throw new Error('Unsupported password hash configuration');
  }
  return bcrypt.compare(password, hash);
};
// Public dummy fixture, not an account credential. Unknown usernames do one cost-10 comparison.
const DUMMY_HASH =
  '$2b$10$qZJ9My6tPcAWAYNmlFbfoOESfqFNt1lov4Gjv6eru7.rE8KItdn.m';
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 30 * 60_000;
const MAX_LOGIN_CONCURRENCY = 8;
type Failure = { status: 401 | 403 | 423; message: string };
type Success = { data: LoginData; expiresAt: Date; principal: AuthPrincipal };
function failure(status: Failure['status'], message: string): Failure {
  return { status, message };
}
function httpError(status: number, message: string): HttpException {
  return new HttpException(
    { success: false, errorMessage: message, errorCode: status },
    status,
  );
}

export function tokenLifetimeSeconds(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d|w|y)?$/i.exec(value);
  const factors: Record<string, number> = {
    ms: 0.001,
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
    w: 604800,
    y: 31557600,
  };
  const seconds = match
    ? Math.floor(Number(match[1]) * factors[(match[2] ?? 's').toLowerCase()])
    : NaN;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 315_576_000) {
    throw httpError(500, '登录有效期配置无效');
  }
  return seconds;
}

@Injectable()
export class LoginService {
  private active = 0;
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(LOGIN_REPOSITORY) private readonly repository: LoginRepositoryPort,
    @Inject(PASSWORD_COMPARER) private readonly compare: PasswordComparer,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  async login(
    body: unknown,
    context: { ip: string; userAgent: string },
  ): Promise<Success> {
    if (this.env.AUTH_DATA_AUTHORITY !== 'postgresql') {
      throw httpError(503, '鉴权权威源尚未切换，请使用现有登录入口');
    }
    const parsed = loginRequestSchema.safeParse(body);
    if (
      !parsed.success ||
      parsed.data.username.length > 50 ||
      parsed.data.password.length > 1024
    ) {
      throw httpError(400, '用户名和密码不能为空');
    }
    if (this.active >= MAX_LOGIN_CONCURRENCY)
      throw httpError(429, '登录请求繁忙，请稍后再试');
    const ttl = tokenLifetimeSeconds(
      parsed.data.rememberMe
        ? this.env.JWT_REMEMBER_EXPIRES_IN
        : this.env.JWT_EXPIRES_IN,
    );
    this.active++;
    try {
      const outcome = await this.repository.transaction((unit) =>
        this.attempt(unit, parsed.data, context, ttl),
      );
      if ('status' in outcome) throw httpError(outcome.status, outcome.message);
      this.logger.info('用户登录成功', 'LoginService', {
        authority: 'postgresql',
      });
      return outcome;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error('登录事务失败', 'LoginService', {
        reason: 'login_transaction_failed',
      });
      throw httpError(500, '登录失败');
    } finally {
      this.active--;
    }
  }

  private async attempt(
    unit: LoginUnit,
    input: LoginRequest,
    context: { ip: string; userAgent: string },
    ttl: number,
  ): Promise<Success | Failure> {
    const user = await unit.lockUser(input.username);
    const now = new Date(); // Taken after acquiring the user lock, not before a wait.
    const ip = context.ip.slice(0, 50);
    if (!user) {
      await this.compare(input.password, DUMMY_HASH);
      await unit.recordAttempt(input.username, ip, false);
      return failure(401, '用户名或密码错误');
    }
    if (
      (user.status === 'LOCKED' && !user.lockedUntil) ||
      (user.lockedUntil && user.lockedUntil > now)
    ) {
      const minutes = user.lockedUntil
        ? Math.max(
            0,
            Math.ceil((user.lockedUntil.getTime() - now.getTime()) / 60_000),
          )
        : 0;
      return failure(423, `账户已锁定，请 ${minutes} 分钟后再试`);
    }
    if (user.lockedUntil && user.lockedUntil <= now) {
      user.lockedUntil = null;
      user.failedLoginAttempts = 0;
      user.lastFailedLogin = null;
      if (user.status === 'LOCKED') user.status = 'ACTIVE';
      await unit.updateUser(user.id, {
        status: user.status,
        lockedUntil: null,
        failedLoginAttempts: 0,
        lastFailedLogin: null,
      });
    }
    if ((user.failedLoginAttempts ?? 0) >= MAX_FAILED_ATTEMPTS)
      return failure(423, '账户已锁定，请 0 分钟后再试');
    const status = normalizeUserStatus(user.status, user.lockedUntil, now);
    if (status !== 'ACTIVE') return failure(403, userStatusMessage(status));
    if (!(await this.compare(input.password, user.password))) {
      const attempts = (user.failedLoginAttempts ?? 0) + 1;
      await unit.recordAttempt(input.username, ip, false);
      await unit.updateUser(user.id, {
        failedLoginAttempts: attempts,
        lastFailedLogin: now,
        ...(attempts >= MAX_FAILED_ATTEMPTS
          ? {
              status: 'LOCKED',
              lockedUntil: new Date(now.getTime() + LOCKOUT_MS),
            }
          : {}),
      });
      return failure(401, '用户名或密码错误');
    }
    const passwordExpired =
      user.passwordExpiresAt !== null && user.passwordExpiresAt <= now;
    const forcePasswordChange = Boolean(
      user.forcePasswordChange || passwordExpired,
    );
    const sessionId = randomUUID();
    const issuedAt = Math.floor(now.getTime() / 1000);
    const expiresAt = new Date((issuedAt + ttl) * 1000);
    const token = jwt.sign(
      { userId: user.id, sessionId, iat: issuedAt },
      this.env.JWT_SECRET,
      { algorithm: 'HS256', expiresIn: ttl },
    );
    const access = await unit.access(user.id);
    await unit.updateUser(user.id, {
      lastLoginTime: now,
      lastLoginIp: ip,
      failedLoginAttempts: 0,
      lastFailedLogin: null,
      forcePasswordChange,
    });
    await unit.recordAttempt(input.username, ip, true);
    await unit.createSession({
      id: sessionId,
      userId: user.id,
      userAgent: context.userAgent.slice(0, 255),
      ipAddress: ip,
      expiresAt,
      rememberMe: input.rememberMe,
      status: 'ACTIVE',
      createdAt: now,
      lastActiveAt: now,
    });
    return {
      expiresAt,
      principal: {
        userId: user.id,
        sessionId,
        user: {
          id: user.id,
          username: user.username,
          realName: user.realName,
          status,
          lastLoginTime: user.lastLoginTime,
          lastLoginIp: user.lastLoginIp,
          passwordExpiresAt: user.passwordExpiresAt,
          passwordChangedAt: user.passwordChangedAt,
          forcePasswordChange,
          failedLoginAttempts: user.failedLoginAttempts,
          lockedUntil: user.lockedUntil,
          createTime: user.createTime,
          updateTime: user.updateTime,
        },
      },
      data: {
        token,
        sessionId,
        user: publicUser({ ...user, status, forcePasswordChange }),
        permissions: access.permissions,
        roles: access.roles.map((role) => role.code),
        mustChangePassword: forcePasswordChange,
        passwordExpired,
      },
    };
  }
}
