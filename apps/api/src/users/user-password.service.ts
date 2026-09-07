import type { Env } from '@asin-monitor/config';
import { adminResetPasswordRequestSchema } from '@asin-monitor/contracts';
import type { UserPasswordRepositoryPort } from '@asin-monitor/db';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { PasswordHasher } from '../auth/account.service';
import { authorizeAdministration } from '../auth/administration-authorization';
import type { AuthPrincipal } from '../auth/auth.types';
import type { PasswordComparer } from '../auth/login.service';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';

export const USER_PASSWORD_REPOSITORY = Symbol('USER_PASSWORD_REPOSITORY');
export const USER_PASSWORD_HASHER = Symbol('USER_PASSWORD_HASHER');
export const USER_PASSWORD_COMPARER = Symbol('USER_PASSWORD_COMPARER');

function fail(status: number, message: string): never {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage: message },
    status,
  );
}

@Injectable()
export class UserPasswordService {
  private active = 0;
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(USER_PASSWORD_REPOSITORY)
    private readonly repository: UserPasswordRepositoryPort,
    @Inject(USER_PASSWORD_HASHER) private readonly hash: PasswordHasher,
    @Inject(USER_PASSWORD_COMPARER) private readonly compare: PasswordComparer,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  async reset(principal: AuthPrincipal, userId: string, body: unknown) {
    if (this.env.AUTH_DATA_AUTHORITY !== 'postgresql')
      fail(503, '用户管理权威源尚未切换，请使用现有用户入口');
    if (
      !userId ||
      [...userId].length > 50 ||
      /[\u0000-\u001f\u007f]/.test(userId)
    )
      fail(400, '用户ID格式无效');
    if (userId === principal.userId) fail(400, '请使用个人中心修改自己的密码');
    const parsed = adminResetPasswordRequestSchema.safeParse(body);
    if (!parsed.success)
      fail(400, parsed.error.issues.map((issue) => issue.message).join('；'));
    const input = parsed.data;
    if (input.newPassword.length > 1024 || input.newPassword.includes('\0'))
      fail(400, '密码格式无效');
    if (this.active >= 8) fail(429, '密码重置繁忙，请稍后再试');
    this.active++;
    try {
      // Keep hashing outside the RBAC/user locks. Current/history comparisons
      // happen only after locking the target to serialize all password writers.
      const hash = await this.hash(input.newPassword);
      await this.repository.transaction(async (unit) => {
        await authorizeAdministration(unit, principal, 'user:write');
        const credentials = unit.credentials;
        const user = await credentials.lockUser(userId);
        if (!user) fail(404, '用户不存在');
        if (input.newPassword.toLowerCase() === user.username.toLowerCase())
          fail(400, '密码不能与用户名相同');
        if (await this.compare(input.newPassword, user.password))
          fail(400, '新密码不能与当前密码相同');
        for (const previous of await credentials.recentPasswords(userId)) {
          if (await this.compare(input.newPassword, previous))
            fail(400, '新密码不能与最近 5 次使用过的密码相同');
        }
        const now = new Date();
        const expiresAt = new Date(
          now.getTime() + this.env.PASSWORD_EXPIRE_DAYS * 86_400_000,
        );
        await credentials.savePreviousPassword(userId, user.password, now);
        await credentials.updatePassword(
          userId,
          hash,
          now,
          expiresAt,
          input.forceChangeOnNextLogin,
        );
        if (input.revokeAllSessions) await unit.revokeAllSessions(userId, now);
      });
      this.logger.info('管理员重置密码成功', 'UserPasswordService');
      return input.revokeAllSessions && input.forceChangeOnNextLogin
        ? '密码修改成功，用户会话已全部下线，下次登录需修改密码'
        : '密码修改成功';
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error('管理员重置密码失败', 'UserPasswordService', {
        reason: 'password_reset_failed',
      });
      fail(500, '修改密码失败');
    } finally {
      this.active--;
    }
  }
}
