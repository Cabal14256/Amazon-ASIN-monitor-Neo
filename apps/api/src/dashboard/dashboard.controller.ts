import { Controller, Get, Inject, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { DashboardGuard } from './dashboard.guard';
import { DashboardService } from './dashboard.service';

@Controller('dashboard')
@UseGuards(DashboardGuard)
export class DashboardController {
  constructor(
    @Inject(DashboardService) private readonly service: DashboardService,
  ) {}
  @Get()
  async read(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    const encoded = await this.service.read(request.auth!, reply);
    return reply.type('application/json; charset=utf-8').send(encoded);
  }
}
