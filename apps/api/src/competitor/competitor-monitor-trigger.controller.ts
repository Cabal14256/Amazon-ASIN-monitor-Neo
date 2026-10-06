import {
  Catch,
  Controller,
  Header,
  HttpCode,
  Inject,
  Post,
  Req,
  UseFilters,
  UseGuards,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import {
  CompetitorMonitorDisabled,
  CompetitorMonitorSubmissionUnconfirmed,
  CompetitorMonitorTriggerService,
} from './competitor-monitor-trigger.service';

@Catch(CompetitorMonitorSubmissionUnconfirmed, CompetitorMonitorDisabled)
class MonitorSubmissionFilter implements ExceptionFilter {
  catch(
    error: CompetitorMonitorSubmissionUnconfirmed | CompetitorMonitorDisabled,
    host: ArgumentsHost,
  ) {
    host
      .switchToHttp()
      .getResponse<FastifyReply>()
      .status(error.getStatus())
      .send(error.getResponse());
  }
}

@Controller('competitor/monitor')
@UseGuards(AuthenticationGuard, PermissionsGuard)
@RequirePermissions('monitor:write')
@UseFilters(MonitorSubmissionFilter)
export class CompetitorMonitorTriggerController {
  constructor(
    @Inject(CompetitorMonitorTriggerService)
    private readonly service: CompetitorMonitorTriggerService,
  ) {}
  @Post('trigger')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async trigger(@Req() request: FastifyRequest) {
    return {
      success: true,
      errorCode: 0,
      data: await this.service.trigger(request.auth!, request.body),
    };
  }
}
