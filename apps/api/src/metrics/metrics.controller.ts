import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import { MetricsService } from './metrics.service';

@Controller()
export class MetricsController {
  constructor(
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  /** 对齐旧系统 GET /metrics（根级，不在 /api/v1 前缀下） */
  @Get('/metrics')
  async getMetrics(
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<string> {
    reply.header('Content-Type', this.metrics.contentType);
    return this.metrics.render();
  }
}
