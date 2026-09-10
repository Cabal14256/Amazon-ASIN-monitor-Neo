import type { Env } from '@asin-monitor/config';
import {
  Catch,
  Controller,
  Header,
  HttpCode,
  HttpException,
  Inject,
  Post,
  Req,
  Res,
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
  AsinImportService,
  ImportSubmissionError,
} from './asin-import.service';

@Catch(ImportSubmissionError)
class ImportSubmissionFilter implements ExceptionFilter {
  catch(error: ImportSubmissionError, host: ArgumentsHost) {
    host
      .switchToHttp()
      .getResponse<FastifyReply>()
      .status(500)
      .send(error.getResponse());
  }
}
@Controller()
@UseGuards(AuthenticationGuard, PermissionsGuard)
@RequirePermissions('asin:write')
@UseFilters(ImportSubmissionFilter)
export class AsinImportController {
  constructor(
    @Inject(AsinImportService) private readonly service: AsinImportService,
    @Inject(ENV) private readonly env: Env,
  ) {}
  @Post('variant-groups/import-excel')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async execute(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
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
      data: await this.service.execute(request.auth!, request, reply),
    };
  }
}
