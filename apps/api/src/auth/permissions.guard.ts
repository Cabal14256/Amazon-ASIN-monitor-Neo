import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';

import type { PermissionCode } from '@asin-monitor/contracts';
import { PermissionCacheService } from './permission-cache.service';
import { REQUIRED_PERMISSIONS } from './require-permissions.decorator';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(PermissionCacheService)
    private readonly cache: PermissionCacheService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<PermissionCode[]>(
      REQUIRED_PERMISSIONS,
      [context.getHandler(), context.getClass()],
    );
    if (!required?.length) return true;

    const principal = context.switchToHttp().getRequest<FastifyRequest>().auth;
    if (!principal) {
      throw new UnauthorizedException({
        success: false,
        errorMessage: '未认证',
        errorCode: 401,
      });
    }
    const granted = await this.cache.getPermissions(principal.userId);
    if (!required.every((permission) => granted.includes(permission))) {
      throw new ForbiddenException({
        success: false,
        errorMessage: '没有权限执行此操作',
        errorCode: 403,
      });
    }
    return true;
  }
}
