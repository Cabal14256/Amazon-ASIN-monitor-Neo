import type { Env } from '@asin-monitor/config';
import {
  changePasswordRequestSchema,
  updateProfileRequestSchema,
} from '@asin-monitor/contracts';
import type { AccountRepositoryPort, AccountUnit } from '@asin-monitor/db';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import { publicUser } from './auth.controller';
import type { AuthPrincipal } from './auth.types';
import {
  normalizeUserStatus,
  userStatusMessage,
} from './authentication.service';
import { PASSWORD_COMPARER, type PasswordComparer } from './login.service';
import { boundedPasswordWork } from './password-work';

export const ACCOUNT_REPOSITORY = Symbol('ACCOUNT_REPOSITORY');
export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');
export type PasswordHasher = (password: string) => Promise<string>;
export const hashPassword: PasswordHasher = (password) =>
  boundedPasswordWork(
    () => bcrypt.hash(password, 10),
    '密码处理繁忙，请稍后再试',
  );

function httpError(status: number, message: string): HttpException {
  return new HttpException(
    { success: false, errorMessage: message, errorCode: status },
    status,
  );
}

@Injectable()
export class AccountService {
  private active = 0;
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(ACCOUNT_REPOSITORY)
    private readonly repository: AccountRepositoryPort,
    @Inject(PASSWORD_COMPARER) private readonly compare: PasswordComparer,
    @Inject(PASSWORD_HASHER) private readonly hash: PasswordHasher,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  private assertAuthority() {
    if (this.env.AUTH_DATA_AUTHORITY !== 'postgresql')
      throw httpError(503, '鉴权权威源尚未切换，请使用现有账号入口');
  }
  private async run<T>(
    operation: 'profile' | 'password',
    callback: (unit: AccountUnit) => Promise<T>,
  ): Promise<T> {
    if (this.active >= 8) throw httpError(429, '账号请求繁忙，请稍后再试');
    this.active++;
    try {
      const result = await this.repository.transaction(callback);
      this.logger.info('本人账号更新成功', 'AccountService', { operation });
      return result;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error('本人账号更新失败', 'AccountService', {
        operation,
        reason: 'account_transaction_failed',
      });
      throw httpError(
        500,
        operation === 'password' ? '修改密码失败' : '更新用户信息失败',
      );
    } finally {
      this.active--;
    }
  }
  private async lockAccount(unit: AccountUnit, principal: AuthPrincipal) {
    const user = await unit.lockUser(principal.userId);
    if (!user) throw httpError(404, '用户不存在');
    const status = normalizeUserStatus(user.status, user.lockedUntil);
    if (status !== 'ACTIVE') throw httpError(403, userStatusMessage(status));
    // The HTTP guard ran before waiting for this lock. Recheck revocation/expiry
    // and hold the session lock through commit to close that race.
    const session = await unit.lockSession(
      principal.userId,
      principal.sessionId,
    );
    if (
      !session ||
      session.status !== 'ACTIVE' ||
      (session.expiresAt !== null && session.expiresAt <= new Date())
    )
      throw httpError(403, '会话已失效');
    return { ...user, status };
  }
  async updateProfile(principal: AuthPrincipal, body: unknown) {
    this.assertAuthority();
    const parsed = updateProfileRequestSchema.safeParse(body);
    if (
      !parsed.success ||
      parsed.data.real_name === undefined ||
      [...parsed.data.real_name].length > 100 ||
      parsed.data.real_name.includes('\0')
    )
      throw httpError(400, '个人资料格式无效');
    const realName = parsed.data.real_name;
    return this.run('profile', async (unit) => {
      const current = await this.lockAccount(unit, principal);
      const updated = await unit.updateProfile(
        principal.userId,
        realName,
        new Date(),
      );
      const access = await unit.access(principal.userId);
      return {
        user: publicUser({
          ...updated,
          status: current.status,
          forcePasswordChange: Boolean(updated.forcePasswordChange),
        }),
        permissions: access.permissions,
        roles: access.roles.map((role) => role.code),
      };
    });
  }
  async changePassword(principal: AuthPrincipal, body: unknown) {
    this.assertAuthority();
    const parsed = changePasswordRequestSchema.safeParse(body);
    if (!parsed.success)
      throw httpError(
        400,
        parsed.error.issues.map((issue) => issue.message).join('；'),
      );
    const input = parsed.data;
    if (
      input.oldPassword.length > 1024 ||
      input.newPassword.length > 1024 ||
      input.newPassword.includes('\0')
    )
      throw httpError(400, '密码格式无效');
    await this.run('password', async (unit) => {
      const user = await this.lockAccount(unit, principal);
      if (input.newPassword.toLowerCase() === user.username.toLowerCase())
        throw httpError(400, '密码不能与用户名相同');
      if (!(await this.compare(input.oldPassword, user.password)))
        throw httpError(400, '原密码错误');
      if (await this.compare(input.newPassword, user.password))
        throw httpError(400, '新密码不能与当前密码相同');
      for (const hash of await unit.recentPasswords(user.id)) {
        if (await this.compare(input.newPassword, hash))
          throw httpError(400, '新密码不能与最近 5 次使用过的密码相同');
      }
      const hash = await this.hash(input.newPassword);
      const now = new Date();
      const expiresAt = new Date(
        now.getTime() + this.env.PASSWORD_EXPIRE_DAYS * 86_400_000,
      );
      await unit.savePreviousPassword(user.id, user.password, now);
      await unit.updatePassword(user.id, hash, now, expiresAt);
      if (input.revokeOtherSessions)
        await unit.revokeOtherSessions(user.id, principal.sessionId, now);
    });
    return input.revokeOtherSessions
      ? '密码修改成功，其他会话已下线'
      : '密码修改成功';
  }
}
