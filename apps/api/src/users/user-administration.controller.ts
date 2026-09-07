import type { Env } from '@asin-monitor/config';
import {
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { ENV } from '../config/config.module';
import { UserAdministrationService } from './user-administration.service';

@Controller('users')
@UseGuards(AuthenticationGuard, PermissionsGuard)
export class UserAdministrationController {
  constructor(
    @Inject(UserAdministrationService)
    private readonly users: UserAdministrationService,
    @Inject(ENV) private readonly env: Env,
  ) {}
  private assertOrigin(request: FastifyRequest) {
    if (
      request.headers.origin &&
      request.headers.origin !== this.env.CORS_ORIGIN
    )
      throw new HttpException(
        { success: false, errorCode: 403, errorMessage: '不允许的请求来源' },
        403,
      );
  }
  @Post()
  @HttpCode(200)
  @RequirePermissions('user:write')
  async create(@Req() request: FastifyRequest, @Body() body: unknown) {
    this.assertOrigin(request);
    return {
      success: true,
      errorCode: 0,
      data: await this.users.create(request.auth!, body),
    };
  }
  @Put(':userId')
  @RequirePermissions('user:write')
  async update(
    @Req() request: FastifyRequest,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ) {
    this.assertOrigin(request);
    return {
      success: true,
      errorCode: 0,
      data: await this.users.update(request.auth!, userId, body),
    };
  }
  @Delete(':userId')
  @RequirePermissions('user:delete')
  async delete(
    @Req() request: FastifyRequest,
    @Param('userId') userId: string,
  ) {
    this.assertOrigin(request);
    await this.users.delete(request.auth!, userId);
    return { success: true, errorCode: 0, message: '删除成功' };
  }
  @Post('batch-delete')
  @HttpCode(200)
  @RequirePermissions('user:delete')
  async batchDelete(@Req() request: FastifyRequest, @Body() body: unknown) {
    this.assertOrigin(request);
    return {
      success: true,
      errorCode: 0,
      data: await this.users.batchDelete(request.auth!, body),
    };
  }
}
