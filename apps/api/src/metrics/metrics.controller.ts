import { Controller, Get } from '@nestjs/common';

import { MetricsService } from './metrics.service';

@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  /** 对齐旧系统 GET /metrics（根级，不在 /api/v1 前缀下） */
  @Get('/metrics')
  async getMetrics(): Promise<string> {
    return this.metrics.render();
  }
}
