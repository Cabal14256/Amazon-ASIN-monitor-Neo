import type { Env } from '@asin-monitor/config';
import {
  Body,
  Controller,
  Get,
  Header,
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
import { SpApiConfigService } from './sp-api-config.service';

@Controller('sp-api-configs')
@UseGuards(AuthenticationGuard, PermissionsGuard)
export class SpApiConfigController {
  constructor(
    @Inject(SpApiConfigService) private readonly configs: SpApiConfigService,
    @Inject(ENV) private readonly env: Env,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('settings:read')
  async list(@Req() request: FastifyRequest) {
    return {
      success: true,
      errorCode: 0,
      data: await this.configs.list(request.auth!),
    };
  }
  @Get(':configKey')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('settings:read')
  async detail(
    @Param('configKey') key: string,
    @Req() request: FastifyRequest,
  ) {
    return {
      success: true,
      errorCode: 0,
      data: await this.configs.detail(request.auth!, key),
    };
  }
  @Put()
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('settings:write')
  async update(@Body() body: unknown, @Req() request: FastifyRequest) {
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
      data: await this.configs.update(request.auth!, body),
    };
  }
}
