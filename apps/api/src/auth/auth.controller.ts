import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { CurrentUserResult, UserPublic } from '@asin-monitor/contracts';
import type { AuthRepositoryPort } from './auth.constants';
import { AUTH_DATA_REPOSITORY } from './auth.constants';
import { AuthenticationGuard } from './authentication.guard';
import { PermissionCacheService } from './permission-cache.service';

function dateString(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

export function publicUser(
  user: NonNullable<FastifyRequest['auth']>['user'],
): UserPublic {
  return {
    id: user.id,
    username: user.username,
    real_name: user.realName,
    status: user.status,
    last_login_time: dateString(user.lastLoginTime),
    last_login_ip: user.lastLoginIp,
    password_expires_at: dateString(user.passwordExpiresAt),
    password_changed_at: dateString(user.passwordChangedAt),
    force_password_change: user.forcePasswordChange,
    failed_login_attempts: user.failedLoginAttempts ?? 0,
    locked_until: dateString(user.lockedUntil),
    create_time: dateString(user.createTime) ?? undefined,
    update_time: dateString(user.updateTime) ?? undefined,
  };
}

@Controller('auth')
export class AuthController {
  constructor(
    @Inject(PermissionCacheService)
    private readonly permissionCache: PermissionCacheService,
    @Inject(AUTH_DATA_REPOSITORY)
    private readonly repository: AuthRepositoryPort,
  ) {}

  @Get('current-user')
  @UseGuards(AuthenticationGuard)
  async currentUser(
    @Req() request: FastifyRequest,
  ): Promise<CurrentUserResult> {
    const principal = request.auth!;
    const passwordExpired =
      principal.user.passwordExpiresAt !== null &&
      principal.user.passwordExpiresAt <= new Date();
    if (passwordExpired && !principal.user.forcePasswordChange) {
      await this.repository.markPasswordChangeRequired(principal.userId);
      principal.user.forcePasswordChange = true;
    }
    const [permissions, roles] = await Promise.all([
      this.permissionCache.getPermissions(principal.userId),
      this.permissionCache.getRoles(principal.userId),
    ]);
    return {
      success: true,
      data: {
        user: publicUser(principal.user),
        permissions,
        roles,
        sessionId: principal.sessionId,
        mustChangePassword:
          principal.user.forcePasswordChange || passwordExpired,
        passwordExpired,
      },
      errorCode: 0,
    };
  }
}
