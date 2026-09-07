import type { Env } from '@asin-monitor/config';
import {
  Body,
  Controller,
  Delete,
  Header,
  HttpCode,
  HttpException,
  Inject,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { ENV } from '../config/config.module';
import { AsinWriteService } from './asin-write.service';

@Controller()
@UseGuards(AuthenticationGuard, PermissionsGuard)
@RequirePermissions('asin:write')
export class AsinWriteController {
  constructor(
    @Inject(AsinWriteService) private readonly service: AsinWriteService,
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
  @Delete('variant-groups/:groupId')
  @RequirePermissions('asin:delete')
  @Header('Cache-Control', 'no-store')
  async deleteGroup(
    @Req() request: FastifyRequest,
    @Param('groupId') groupId: string,
  ) {
    this.assertOrigin(request);
    return {
      success: true,
      errorCode: 0,
      data: await this.service.deleteGroup(request.auth!, groupId),
    };
  }
  @Delete('asins/:asinId')
  @RequirePermissions('asin:delete')
  @Header('Cache-Control', 'no-store')
  async deleteAsin(
    @Req() request: FastifyRequest,
    @Param('asinId') asinId: string,
  ) {
    this.assertOrigin(request);
    return {
      success: true,
      errorCode: 0,
      data: await this.service.deleteAsin(request.auth!, asinId),
    };
  }
  @Put('variant-groups/:groupId/feishu-notify')
  @Header('Cache-Control', 'no-store')
  async updateGroupNotify(
    @Req() request: FastifyRequest,
    @Param('groupId') groupId: string,
    @Body() body: unknown,
  ) {
    this.assertOrigin(request);
    return {
      success: true,
      errorCode: 0,
      data: await this.service.updateGroupNotify(request.auth!, groupId, body),
    };
  }
  @Put('variant-groups/:groupId/manual-broken')
  @Header('Cache-Control', 'no-store')
  async updateGroupManual(
    @Req() request: FastifyRequest,
    @Param('groupId') groupId: string,
    @Body() body: unknown,
  ) {
    this.assertOrigin(request);
    return {
      success: true,
      errorCode: 0,
      data: await this.service.updateGroupManual(request.auth!, groupId, body),
    };
  }
  @Put('asins/:asinId/manual-broken')
  @Header('Cache-Control', 'no-store')
  async updateAsinManual(
    @Req() request: FastifyRequest,
    @Param('asinId') asinId: string,
    @Body() body: unknown,
  ) {
    this.assertOrigin(request);
    return {
      success: true,
      errorCode: 0,
      data: await this.service.updateAsinManual(request.auth!, asinId, body),
    };
  }
  @Put('asins/:asinId/feishu-notify')
  @Header('Cache-Control', 'no-store')
  async updateAsinNotify(
    @Req() request: FastifyRequest,
    @Param('asinId') asinId: string,
    @Body() body: unknown,
  ) {
    this.assertOrigin(request);
    return {
      success: true,
      errorCode: 0,
      data: await this.service.updateAsinNotify(request.auth!, asinId, body),
    };
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
    @Param('groupId') groupId: string,
    @Body() body: unknown,
  ) {
    this.assertOrigin(request);
    return {
      success: true,
      errorCode: 0,
      data: await this.service.updateGroup(request.auth!, groupId, body),
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
    @Param('asinId') asinId: string,
    @Body() body: unknown,
  ) {
    this.assertOrigin(request);
    return {
      success: true,
      errorCode: 0,
      data: await this.service.updateAsin(request.auth!, asinId, body),
    };
  }
  @Post('asins/:asinId/move')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async move(
    @Req() request: FastifyRequest,
    @Param('asinId') asinId: string,
    @Body() body: unknown,
  ) {
    this.assertOrigin(request);
    return {
      success: true,
      errorCode: 0,
      data: await this.service.moveAsin(request.auth!, asinId, body),
    };
  }
}
