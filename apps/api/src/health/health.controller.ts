import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

import type { Health } from '@asin-monitor/contracts';
import { HealthService } from './health.service';

/**
 * 旧系统同时暴露根级 /health 与 /api/v1/health；两条路由共享同一真实依赖探针。
 */
@Controller()
export class HealthController {
  constructor(
    @Inject(HealthService) private readonly healthService: HealthService,
  ) {}

  @Get(['health', 'api/v1/health'])
  async getHealth(
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<Health> {
    const health = await this.healthService.getHealth();
    reply.status(health.status === 'ok' ? 200 : 503);
    return health;
  }
}
