import type { Env } from '@asin-monitor/config';
import {
  Body,
  Controller,
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
import { UserPasswordService } from './user-password.service';

@Controller('users')
@UseGuards(AuthenticationGuard, PermissionsGuard)
export class UserPasswordController {
  constructor(
    @Inject(UserPasswordService)
    private readonly passwords: UserPasswordService,
    @Inject(ENV) private readonly env: Env,
  ) {}
  @Put(':userId/password')
  @RequirePermissions('user:write')
  async reset(
    @Req() request: FastifyRequest,
    @Param('userId') userId: string,
    @Body() body: unknown,
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
      message: await this.passwords.reset(request.auth!, userId, body),
    };
  }
}
