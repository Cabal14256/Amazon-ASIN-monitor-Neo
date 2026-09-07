import {
  Controller,
  Get,
  Header,
  Inject,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { SpApiStatusService } from './sp-api-status.service';

@Controller()
@UseGuards(AuthenticationGuard, PermissionsGuard)
export class SpApiStatusController {
  constructor(
    @Inject(SpApiStatusService) private readonly status: SpApiStatusService,
  ) {}
  @Get('rate-limiter/status')
  @Header('Cache-Control', 'no-store')
  @RequirePermissions('settings:read')
  async quota(@Req() request: FastifyRequest, @Query() query: unknown) {
    return {
      success: true,
      errorCode: 0,
      data: await this.status.quota(request.auth!, query),
    };
  }
  @Get('error-stats')
  @Header('Cache-Control', 'no-store')
  @Header('X-SP-API-Statistics-Scope', 'api-process')
  @Header('X-SP-API-Statistics-Unit', 'upstream-attempt')
  @RequirePermissions('settings:read')
  async errors(@Req() request: FastifyRequest, @Query() query: unknown) {
    return {
      success: true,
      errorCode: 0,
      data: await this.status.errors(request.auth!, query),
    };
  }
}
