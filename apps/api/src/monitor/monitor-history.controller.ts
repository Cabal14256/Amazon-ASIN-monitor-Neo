import {
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { MonitorHistoryService } from './monitor-history.service';

@Controller('monitor-history')
@UseGuards(AuthenticationGuard, PermissionsGuard)
@RequirePermissions('monitor:read')
export class MonitorHistoryController {
  constructor(
    @Inject(MonitorHistoryService)
    private readonly service: MonitorHistoryService,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  async list(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Query() query: unknown,
  ) {
    return {
      success: true,
      errorCode: 0,
      data: await this.service.list(request.auth!, reply, query),
    };
  }
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  async detail(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Param('id') id: string,
  ) {
    return {
      success: true,
      errorCode: 0,
      data: await this.service.detail(request.auth!, reply, id),
    };
  }
}
