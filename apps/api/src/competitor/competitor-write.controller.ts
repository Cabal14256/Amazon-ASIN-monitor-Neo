import type { Env } from '@asin-monitor/config';
import {
  Body,
  Catch,
  Controller,
  Header,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Put,
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
  CompetitorCommitUncertainError,
  CompetitorWriteService,
} from './competitor-write.service';

@Catch(CompetitorCommitUncertainError)
class CompetitorCommitUncertainFilter implements ExceptionFilter {
  catch(error: CompetitorCommitUncertainError, host: ArgumentsHost) {
    host
      .switchToHttp()
      .getResponse<FastifyReply>()
      .header('Cache-Control', 'no-store')
      .status(503)
      .send(error.getResponse());
  }
}

@Controller('competitor')
@UseGuards(AuthenticationGuard, PermissionsGuard)
@RequirePermissions('asin:write')
@UseFilters(CompetitorCommitUncertainFilter)
export class CompetitorWriteController {
  constructor(
    @Inject(CompetitorWriteService)
    private readonly service: CompetitorWriteService,
    @Inject(ENV) private readonly env: Env,
  ) {}
  private assertOrigin(request: FastifyRequest) {
    if (
      request.headers.origin &&
      request.headers.origin !== this.env.CORS_ORIGIN
    )
      throw new HttpException(
        { success: false, errorCode: 403, errorMessage: '不允许的请求来源' },
        403,
      );
  }
  @Post('variant-groups')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async createGroup(@Req() request: FastifyRequest, @Body() body: unknown) {
    this.assertOrigin(request);
    return {
      success: true,
      errorCode: 0,
      data: await this.service.createGroup(request.auth!, body),
    };
  }
  @Put('variant-groups/:groupId')
  @Header('Cache-Control', 'no-store')
  async updateGroup(
    @Req() request: FastifyRequest,
    @Param('groupId') id: string,
    @Body() body: unknown,
  ) {
    this.assertOrigin(request);
    return {
      success: true,
      errorCode: 0,
      data: await this.service.updateGroup(request.auth!, id, body),
    };
  }
  @Post('asins')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async createAsin(@Req() request: FastifyRequest, @Body() body: unknown) {
    this.assertOrigin(request);
    return {
      success: true,
      errorCode: 0,
      data: await this.service.createAsin(request.auth!, body),
    };
  }
  @Put('asins/:asinId')
  @Header('Cache-Control', 'no-store')
  async updateAsin(
    @Req() request: FastifyRequest,
    @Param('asinId') id: string,
    @Body() body: unknown,
  ) {
    this.assertOrigin(request);
    return {
      success: true,
      errorCode: 0,
      data: await this.service.updateAsin(request.auth!, id, body),
    };
  }
  @Post('asins/:asinId/move')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async moveAsin(
    @Req() request: FastifyRequest,
    @Param('asinId') id: string,
    @Body() body: unknown,
  ) {
    this.assertOrigin(request);
    return {
      success: true,
      errorCode: 0,
      data: await this.service.moveAsin(request.auth!, id, body),
    };
  }
}
