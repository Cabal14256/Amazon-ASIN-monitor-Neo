import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { FeishuConfigGuard } from './feishu-config.guard';
import { FeishuConfigService } from './feishu-config.service';

const result = <T>(data: T) => ({ success: true, errorCode: 0, data });
@Controller('feishu-configs')
@UseGuards(FeishuConfigGuard)
export class FeishuConfigController {
  constructor(
    @Inject(FeishuConfigService) private readonly configs: FeishuConfigService,
  ) {}
  @Get()
  async list(@Req() request: FastifyRequest) {
    return result(await this.configs.list(request.auth!));
  }
  @Get(':country')
  async detail(
    @Req() request: FastifyRequest,
    @Param('country') country: string,
  ) {
    return result(await this.configs.detail(request.auth!, country));
  }
  @Post()
  @HttpCode(200)
  async create(@Req() request: FastifyRequest, @Body() body: unknown) {
    return result(await this.configs.upsert(request.auth!, body));
  }
  @Put(':country')
  async update(@Req() request: FastifyRequest, @Body() body: unknown) {
    // Legacy PUT intentionally takes the country from the body, not this path.
    return result(await this.configs.upsert(request.auth!, body));
  }
  @Delete(':country')
  async delete(
    @Req() request: FastifyRequest,
    @Param('country') country: string,
  ) {
    return result(await this.configs.delete(request.auth!, country));
  }
  @Patch(':country/toggle')
  async toggle(
    @Req() request: FastifyRequest,
    @Param('country') country: string,
    @Body() body: unknown,
  ) {
    return result(await this.configs.toggle(request.auth!, country, body));
  }
}
