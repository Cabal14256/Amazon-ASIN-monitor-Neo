import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { OpsService } from './ops.service';

@Controller('ops')
@UseGuards(AuthenticationGuard, PermissionsGuard)
export class OpsController {
  constructor(@Inject(OpsService) private readonly ops: OpsService) {}

  @Get('overview')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('settings:read')
  overview(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return this.ops.overview(request.auth!, reply);
  }

  @Post('analytics/cache/clear')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('settings:write')
  clearCache(@Req() request: FastifyRequest) {
    return this.ops.clearCache(request.auth!);
  }

  @Post('analytics/refresh')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('settings:write')
  refresh(@Req() request: FastifyRequest, @Body() body: unknown) {
    return this.ops.refresh(request.auth!, body);
  }
}
