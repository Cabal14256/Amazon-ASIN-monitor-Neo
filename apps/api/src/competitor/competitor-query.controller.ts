import {
  Controller,
  Get,
  Header,
  Inject,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { CompetitorQueryService } from './competitor-query.service';

@Controller('competitor/variant-groups')
@UseGuards(AuthenticationGuard, PermissionsGuard)
@RequirePermissions('asin:read')
export class CompetitorQueryController {
  constructor(
    @Inject(CompetitorQueryService)
    private readonly service: CompetitorQueryService,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  async list(@Req() request: FastifyRequest, @Query() query: unknown) {
    return {
      success: true,
      errorCode: 0,
      data: await this.service.list(request.auth!, query),
    };
  }
  @Get(':groupId')
  @Header('Cache-Control', 'no-store')
  async detail(
    @Req() request: FastifyRequest,
    @Param('groupId') groupId: string,
  ) {
    return {
      success: true,
      errorCode: 0,
      data: await this.service.detail(request.auth!, groupId),
    };
  }
}

@Controller('competitor/catalog/variant-groups')
@UseGuards(AuthenticationGuard, PermissionsGuard)
@RequirePermissions('asin:read')
export class CompetitorLiteralDetailController {
  constructor(
    @Inject(CompetitorQueryService)
    private readonly service: CompetitorQueryService,
  ) {}
  @Get('detail')
  @Header('Cache-Control', 'no-store')
  async detail(@Req() request: FastifyRequest) {
    return {
      success: true,
      errorCode: 0,
      data: await this.service.literalDetail(request.auth!, request.raw.url!),
    };
  }
}
