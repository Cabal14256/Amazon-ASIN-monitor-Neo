import type { Env } from '@asin-monitor/config';
import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Param,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { ENV } from '../config/config.module';
import { RoleService } from './role.service';

@Controller()
@UseGuards(AuthenticationGuard, PermissionsGuard)
export class RoleController {
  constructor(
    @Inject(RoleService) private readonly roles: RoleService,
    @Inject(ENV) private readonly env: Env,
  ) {}
  @Get('roles')
  @RequirePermissions('role:read')
  async list() {
    return { success: true, errorCode: 0, data: await this.roles.listRoles() };
  }
  @Get('users/roles/all')
  @RequirePermissions('role:read')
  async all() {
    return { success: true, errorCode: 0, data: await this.roles.allRoles() };
  }
  @Get('roles/:roleId')
  @RequirePermissions('role:read')
  async detail(@Param('roleId') roleId: string) {
    return {
      success: true,
      errorCode: 0,
      data: await this.roles.roleDetail(roleId),
    };
  }
  @Get('permissions')
  @RequirePermissions('role:read')
  async permissions() {
    return {
      success: true,
      errorCode: 0,
      data: await this.roles.listPermissions(),
    };
  }
  @Put('roles/:roleId/permissions')
  @RequirePermissions('role:write')
  async assign(
    @Param('roleId') roleId: string,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    if (
      request.headers.origin &&
      request.headers.origin !== this.env.CORS_ORIGIN
    )
      throw new HttpException(
        { success: false, errorCode: 403, errorMessage: '不允许的请求来源' },
        403,
      );
    return {
      success: true,
      errorCode: 0,
      data: await this.roles.assignPermissions(request.auth!, roleId, body),
    };
  }
}
