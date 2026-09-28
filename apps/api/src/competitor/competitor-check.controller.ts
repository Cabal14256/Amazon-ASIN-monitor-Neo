import {
  Catch,
  Controller,
  Header,
  HttpCode,
  Inject,
  Param,
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
import { VariantCheckSubmissionError } from '../variant-check/variant-check.service';
import { CompetitorCheckService } from './competitor-check.service';

@Catch(VariantCheckSubmissionError)
class CompetitorCheckSubmissionFilter implements ExceptionFilter {
  catch(error: VariantCheckSubmissionError, host: ArgumentsHost) {
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
@RequirePermissions('asin:read')
@UseFilters(CompetitorCheckSubmissionFilter)
export class CompetitorCheckController {
  constructor(
    @Inject(CompetitorCheckService)
    private readonly service: CompetitorCheckService,
  ) {}
  @Post('variant-groups/:groupId/check')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async group(
    @Param('groupId') id: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return {
      success: true,
      errorCode: 0,
      data: await this.service.execute(
        'competitor-variant-group-check',
        id,
        request,
        reply,
      ),
    };
  }
  @Post('asins/:asinId/check')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async single(
    @Param('asinId') id: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return {
      success: true,
      errorCode: 0,
      data: await this.service.execute(
        'competitor-asin-check',
        id,
        request,
        reply,
      ),
    };
  }
}
