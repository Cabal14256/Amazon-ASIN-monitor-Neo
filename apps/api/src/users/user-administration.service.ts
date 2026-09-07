import type { Env } from '@asin-monitor/config';
import {
  batchDeleteUsersRequestSchema,
  createUserRequestSchema,
  updateUserRequestSchema,
  type PermissionCode,
} from '@asin-monitor/contracts';
import type {
  AuthRoleRecord,
  AuthUserRecord,
  UserAdministrationRepositoryPort,
  UserAdministrationUnit,
} from '@asin-monitor/db';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PasswordHasher } from '../auth/account.service';
import { authorizeAdministration } from '../auth/administration-authorization';
import { publicUser } from '../auth/auth.controller';
import type { AuthPrincipal } from '../auth/auth.types';
import { normalizeUserStatus } from '../auth/authentication.service';
import { PermissionCacheService } from '../auth/permission-cache.service';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';

export const USER_ADMINISTRATION_REPOSITORY = Symbol(
  'USER_ADMINISTRATION_REPOSITORY',
);
export const USER_ADMINISTRATION_HASHER = Symbol('USER_ADMINISTRATION_HASHER');
function fail(status: number, message: string): never {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage: message },
    status,
  );
}
function validId(value: string) {
  return (
    value.length > 0 &&
    [...value].length <= 50 &&
    !/[\x00-\x1f\x7f]/.test(value)
  );
}
function validText(value: string | undefined, max: number) {
  return (
    value === undefined || ([...value].length <= max && !value.includes('\0'))
  );
}
function normalized(user: AuthUserRecord) {
  return normalizeUserStatus(user.status, user.lockedUntil);
}
function hasAdmin(roles: AuthRoleRecord[]) {
  return roles.some((role) => role.code === 'ADMIN');
}
function usernameConflict(error: unknown): boolean {
  for (
    let depth = 0;
    error && typeof error === 'object' && depth < 3;
    depth++
  ) {
    const candidate = error as {
      code?: string;
      constraint?: string;
      cause?: unknown;
    };
    if (
      candidate.code === '23505' &&
      ['uq_users_username_ci', 'users_username_key'].includes(
        candidate.constraint ?? '',
      )
    )
      return true;
    error = candidate.cause;
  }
  return false;
}

@Injectable()
export class UserAdministrationService {
  private active = 0;
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(USER_ADMINISTRATION_REPOSITORY)
    private readonly repository: UserAdministrationRepositoryPort,
    @Inject(USER_ADMINISTRATION_HASHER) private readonly hash: PasswordHasher,
    @Inject(PermissionCacheService)
    private readonly cache: PermissionCacheService,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  private async run<T>(
    operation: 'create' | 'update' | 'delete' | 'batch-delete',
    action: () => Promise<T>,
  ): Promise<T> {
    if (this.env.AUTH_DATA_AUTHORITY !== 'postgresql')
      fail(503, '鉴权权威源尚未切换，请使用现有用户管理入口');
    if (this.active >= 8) fail(429, '用户管理请求繁忙，请稍后再试');
    this.active++;
    try {
      const result = await action();
      this.logger.info('用户管理操作完成', 'UserAdministrationService', {
        operation,
      });
      return result;
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (operation === 'create' && usernameConflict(error))
        fail(400, '用户名已存在');
      this.logger.error('用户管理操作失败', 'UserAdministrationService', {
        operation,
        reason: 'user_administration_failed',
      });
      return fail(500, '用户管理操作失败');
    } finally {
      this.active--;
    }
  }
  private async write<T>(
    principal: AuthPrincipal,
    permission: PermissionCode,
    operation: (unit: UserAdministrationUnit) => Promise<T>,
  ): Promise<T> {
    const result = await this.repository.transaction(async (unit) => {
      await authorizeAdministration(unit, principal, permission);
      return operation(unit);
    });
    await this.cache.clearPostgresCaches();
    return result;
  }
  private roleIds(values: string[]) {
    if (values.length > 100 || values.some((id) => id !== '' && !validId(id)))
      fail(400, '角色ID参数无效');
    const ids = [...new Set(values.filter(Boolean))];
    if (!ids.length) fail(400, '请至少保留一个角色');
    return ids;
  }
  private async roles(unit: UserAdministrationUnit, ids: string[]) {
    const roles = await unit.rolesByIds(ids);
    if (roles.length !== ids.length) fail(400, '包含无效角色ID');
    return roles;
  }
  private async result(unit: UserAdministrationUnit, userId: string) {
    const user = await unit.findPublicUser(userId);
    if (!user) throw new Error('Managed user no longer exists');
    return {
      ...publicUser({
        ...user,
        status: normalized(user),
        forcePasswordChange: Boolean(user.forcePasswordChange),
      }),
      roles: await unit.rolesForUser(userId),
    };
  }
  create(principal: AuthPrincipal, body: unknown) {
    const parsed = createUserRequestSchema.safeParse(body);
    if (!parsed.success) fail(400, '创建用户参数无效');
    const input = parsed.data;
    if (
      !validId(input.username) ||
      !input.username.trim() ||
      input.password.length > 1024 ||
      input.password.includes('\0') ||
      !validText(input.real_name, 100)
    )
      fail(400, '创建用户参数无效');
    const roleIds = this.roleIds(input.roleIds);
    return this.run('create', async () => {
      const passwordHash = await this.hash(input.password);
      return this.write(principal, 'user:write', async (unit) => {
        if (await unit.usernameExists(input.username))
          fail(400, '用户名已存在');
        await this.roles(unit, roleIds);
        const id = randomUUID();
        const now = new Date();
        await unit.createUser({
          id,
          username: input.username,
          passwordHash,
          realName: input.real_name || null,
          forcePasswordChange: input.forcePasswordChange,
          passwordExpiresAt: new Date(
            now.getTime() + this.env.PASSWORD_EXPIRE_DAYS * 86_400_000,
          ),
          now,
        });
        await unit.replaceRoles(id, roleIds);
        return this.result(unit, id);
      });
    });
  }
  update(principal: AuthPrincipal, userId: string, body: unknown) {
    const parsed = updateUserRequestSchema.safeParse(body);
    if (
      !validId(userId) ||
      !parsed.success ||
      !validText(parsed.data.real_name, 100) ||
      !validText(parsed.data.statusReason, 255)
    )
      fail(400, '更新用户参数无效');
    const input = parsed.data;
    const roleIds =
      input.roleIds === undefined ? undefined : this.roleIds(input.roleIds);
    return this.run('update', () =>
      this.write(principal, 'user:write', async (unit) => {
        const user = await unit.lockUser(userId);
        if (!user) fail(404, '用户不存在');
        const currentRoles = await unit.rolesForUser(userId);
        const nextRoles =
          roleIds === undefined
            ? currentRoles
            : await this.roles(unit, roleIds);
        const currentStatus = normalized(user);
        const nextStatus = input.status ?? currentStatus;
        if (principal.userId === userId) {
          if (hasAdmin(currentRoles) && !hasAdmin(nextRoles))
            fail(400, '不能移除自己当前账户的管理员角色');
          if (nextStatus !== 'ACTIVE')
            fail(400, '不能禁用、锁定或停用自己的账户');
        }
        if (
          currentStatus === 'ACTIVE' &&
          hasAdmin(currentRoles) &&
          (nextStatus !== 'ACTIVE' || !hasAdmin(nextRoles)) &&
          (await unit.countActiveAdmins(userId)) === 0
        )
          fail(400, '系统至少需要保留一个启用中的管理员账户');
        const now = new Date();
        if (input.real_name !== undefined)
          await unit.updateName(userId, input.real_name, now);
        if (input.status !== undefined && currentStatus !== input.status)
          await unit.changeStatus(
            userId,
            currentStatus,
            input.status,
            input.statusReason || null,
            principal.userId,
            now,
          );
        if (roleIds !== undefined) await unit.replaceRoles(userId, roleIds);
        return this.result(unit, userId);
      }),
    );
  }
  delete(principal: AuthPrincipal, userId: string) {
    if (!validId(userId)) fail(400, '用户ID格式无效');
    if (userId === principal.userId) fail(400, '不能删除自己的账户');
    return this.run('delete', () =>
      this.write(principal, 'user:delete', async (unit) => {
        const user = await unit.lockUser(userId);
        if (!user) fail(404, '用户不存在');
        if (
          normalized(user) === 'ACTIVE' &&
          hasAdmin(await unit.rolesForUser(userId)) &&
          (await unit.countActiveAdmins(userId)) === 0
        )
          fail(400, '系统至少需要保留一个启用中的管理员账户');
        await unit.deleteUser(userId);
      }),
    );
  }
  batchDelete(principal: AuthPrincipal, body: unknown) {
    const parsed = batchDeleteUsersRequestSchema.safeParse(body);
    if (!parsed.success || parsed.data.userIds.length > 100)
      fail(400, '批量删除参数无效');
    const ids = [
      ...new Set(parsed.data.userIds.map((id) => id.trim()).filter(Boolean)),
    ];
    if (!ids.length || ids.some((id) => !validId(id)))
      fail(400, '批量删除参数无效');
    return this.run('batch-delete', async () => {
      const result = await this.write(
        principal,
        'user:delete',
        async (unit) => {
          const result = {
            totalRequested: ids.length,
            deletedCount: 0,
            skipped: [] as { userId: string; reason: string }[],
            failed: [] as { userId: string; message: string }[],
          };
          let availableAdmins = Math.max(
            (await unit.countActiveAdmins()) - 1,
            0,
          );
          for (const userId of ids) {
            if (userId === principal.userId) {
              result.skipped.push({ userId, reason: '不能删除自己的账户' });
              continue;
            }
            const attempt = await unit.attemptUserOperation(async () => {
              const user = await unit.lockUser(userId);
              if (!user)
                return { deleted: false as const, reason: '用户不存在' };
              const admin =
                normalized(user) === 'ACTIVE' &&
                hasAdmin(await unit.rolesForUser(userId));
              if (admin && availableAdmins === 0)
                return {
                  deleted: false as const,
                  reason: '系统至少需要保留一个启用中的管理员账户',
                };
              await unit.deleteUser(userId);
              return { deleted: true as const, admin };
            });
            if (!attempt.ok)
              result.failed.push({ userId, message: '删除失败' });
            else if (!attempt.value.deleted)
              result.skipped.push({ userId, reason: attempt.value.reason });
            else {
              result.deletedCount++;
              if (attempt.value.admin) availableAdmins--;
            }
          }
          return result;
        },
      );
      if (result.failed.length)
        this.logger.warn('用户批量删除部分失败', 'UserAdministrationService', {
          failedCount: result.failed.length,
          deletedCount: result.deletedCount,
        });
      return result;
    });
  }
}
