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
  MonitorSubmissionUnconfirmed,
  MonitorTriggerService,
} from './monitor-trigger.service';

@Catch(MonitorSubmissionUnconfirmed)
class MonitorSubmissionFilter implements ExceptionFilter {
  catch(error: MonitorSubmissionUnconfirmed, host: ArgumentsHost) {
    host
      .switchToHttp()
      .getResponse<FastifyReply>()
      .status(500)
      .send(error.getResponse());
  }
}

@Controller('monitor')
@UseGuards(AuthenticationGuard, PermissionsGuard)
@RequirePermissions('monitor:write')
@UseFilters(MonitorSubmissionFilter)
export class MonitorTriggerController {
  constructor(
    @Inject(MonitorTriggerService)
    private readonly service: MonitorTriggerService,
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
