import type { Env } from '@asin-monitor/config';
import {
  Body,
  Catch,
  Controller,
  Header,
  HttpCode,
  HttpException,
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
import { ENV } from '../config/config.module';
import {
  AsinBatchDeleteService,
  BatchDeleteSubmissionError,
} from './asin-batch-delete.service';

@Catch(BatchDeleteSubmissionError)
class BatchDeleteSubmissionFilter implements ExceptionFilter {
  catch(error: BatchDeleteSubmissionError, host: ArgumentsHost) {
    host
      .switchToHttp()
      .getResponse<FastifyReply>()
      .status(500)
      .send(error.getResponse());
  }
}

@Controller()
@UseGuards(AuthenticationGuard, PermissionsGuard)
@RequirePermissions('asin:delete')
@UseFilters(BatchDeleteSubmissionFilter)
export class AsinBatchDeleteController {
  constructor(
    @Inject(AsinBatchDeleteService)
    private readonly service: AsinBatchDeleteService,
    @Inject(ENV) private readonly env: Env,
  ) {}
  @Post('variant-groups/batch-delete')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async execute(@Req() request: FastifyRequest, @Body() body: unknown) {
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
      data: await this.service.execute(request.auth!, body),
    };
  }
}
