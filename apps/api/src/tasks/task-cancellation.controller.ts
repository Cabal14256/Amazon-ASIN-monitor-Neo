import type { Env } from '@asin-monitor/config';
import {
  Controller,
  Header,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { ENV } from '../config/config.module';
import { TaskCancellationService } from './task-cancellation.service';

@Controller('tasks')
@UseGuards(AuthenticationGuard)
export class TaskCancellationController {
  constructor(
    @Inject(TaskCancellationService)
    private readonly service: TaskCancellationService,
    @Inject(ENV) private readonly env: Env,
  ) {}
  @Post(':taskId/cancel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async cancel(
    @Req() request: FastifyRequest,
    @Param('taskId') taskId: string,
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
      data: await this.service.cancel(request.auth!, taskId),
    };
  }
}
