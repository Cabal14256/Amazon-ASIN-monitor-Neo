import type { Env } from '@asin-monitor/config';
import {
  Catch,
  Controller,
  Header,
  HttpCode,
  Inject,
  Injectable,
  Param,
  Post,
  Req,
  Res,
  UseFilters,
  UseGuards,
  type ArgumentsHost,
  type CanActivate,
  type ExceptionFilter,
  type ExecutionContext,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { AuthenticationService } from '../auth/authentication.service';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { ENV } from '../config/config.module';
import {
  VariantCheckService,
  VariantCheckSubmissionError,
} from './variant-check.service';

@Catch(VariantCheckSubmissionError)
class VariantCheckSubmissionFilter implements ExceptionFilter {
  catch(error: VariantCheckSubmissionError, host: ArgumentsHost) {
    host
      .switchToHttp()
      .getResponse<FastifyReply>()
      .status(500)
      .send(error.getResponse());
  }
}

@Injectable()
export class OptionalCheckAuthentication implements CanActivate {
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(AuthenticationService) private readonly auth: AuthenticationService,
  ) {}
  async canActivate(context: ExecutionContext) {
    const http = context.switchToHttp(),
      request = http.getRequest<FastifyRequest>();
    if (
      request.headers.authorization !== undefined ||
      request.cookies[this.env.AUTH_COOKIE_NAME] !== undefined
    )
      request.auth = await this.auth.authenticate(
        request,
        http.getResponse<FastifyReply>(),
      );
    return true;
  }
}
@Controller()
@UseFilters(VariantCheckSubmissionFilter)
export class VariantCheckController {
  constructor(
    @Inject(VariantCheckService) private readonly service: VariantCheckService,
  ) {}
  @Post('variant-groups/:groupId/check')
  @HttpCode(200)
  @UseGuards(OptionalCheckAuthentication)
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
        'variant-group-check',
        request,
        reply,
        id,
      ),
    };
  }
  @Post('asins/:asinId/check')
  @HttpCode(200)
  @UseGuards(OptionalCheckAuthentication)
  @Header('Cache-Control', 'no-store')
  async single(
    @Param('asinId') id: string,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return {
      success: true,
      errorCode: 0,
      data: await this.service.execute('asin-check', request, reply, id),
    };
  }
  @Post('variant-groups/batch-check')
  @HttpCode(200)
  @UseGuards(AuthenticationGuard, PermissionsGuard)
  @RequirePermissions('asin:read')
  @Header('Cache-Control', 'no-store')
  async batch(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return {
      success: true,
      errorCode: 0,
      data: await this.service.execute('variant-group', request, reply),
    };
  }
  @Post('variant-check/batch-query-parent-asin')
  @HttpCode(200)
  @UseGuards(AuthenticationGuard, PermissionsGuard)
  @RequirePermissions('asin:read')
  @Header('Cache-Control', 'no-store')
  async parent(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return {
      success: true,
      errorCode: 0,
      data: await this.service.execute('parent-asin-query', request, reply),
    };
  }
}
