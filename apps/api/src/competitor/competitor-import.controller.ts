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
import { ImportSubmissionError } from '../asin/asin-import.service';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { ENV } from '../config/config.module';
import { CompetitorImportService } from './competitor-import.service';

@Catch(ImportSubmissionError)
class CompetitorImportSubmissionFilter implements ExceptionFilter {
  catch(error: ImportSubmissionError, host: ArgumentsHost) {
    host
      .switchToHttp()
      .getResponse<FastifyReply>()
      .header('Cache-Control', 'no-store')
      .status(500)
      .send(error.getResponse());
  }
}

@Controller('competitor')
@UseGuards(AuthenticationGuard, PermissionsGuard)
@RequirePermissions('asin:write')
@UseFilters(CompetitorImportSubmissionFilter)
export class CompetitorImportController {
  constructor(
    @Inject(CompetitorImportService)
    private readonly service: CompetitorImportService,
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
