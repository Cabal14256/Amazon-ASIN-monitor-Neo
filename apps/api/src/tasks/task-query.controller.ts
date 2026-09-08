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
import { TaskQueryService } from './task-query.service';

@Controller('tasks')
@UseGuards(AuthenticationGuard)
export class TaskQueryController {
  constructor(
    @Inject(TaskQueryService) private readonly service: TaskQueryService,
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
  @Get(':taskId')
  @Header('Cache-Control', 'no-store')
  async detail(
    @Req() request: FastifyRequest,
    @Param('taskId') taskId: string,
  ) {
    return {
      success: true,
      errorCode: 0,
      data: await this.service.detail(request.auth!, taskId),
    };
  }
}
