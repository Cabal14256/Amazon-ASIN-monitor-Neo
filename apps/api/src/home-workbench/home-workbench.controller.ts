import { Controller, Get, Inject, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { HomeWorkbenchGuard } from './home-workbench.guard';
import { HomeWorkbenchService } from './home-workbench.service';

@Controller('dashboard')
@UseGuards(HomeWorkbenchGuard)
export class HomeWorkbenchController {
  constructor(
    @Inject(HomeWorkbenchService)
    private readonly service: HomeWorkbenchService,
  ) {}
  @Get('workbench')
  async read(@Req() request: FastifyRequest, @Res() reply: FastifyReply) {
    reply.header('Cache-Control', 'no-store');
    const encoded = await this.service.read(
      request.auth!,
      reply,
      request.query,
    );
    return reply.type('application/json; charset=utf-8').send(encoded);
  }
}
