import { Module } from '@nestjs/common';

import { MetricsModule } from '../metrics/metrics.module';
import { HealthController } from './health.controller';
import {
  HealthErrorStatsService,
  HealthRuntimeDependencies,
  HealthService,
} from './health.service';

@Module({
  imports: [MetricsModule],
  controllers: [HealthController],
  providers: [
    HealthErrorStatsService,
    HealthRuntimeDependencies,
    HealthService,
  ],
  exports: [HealthErrorStatsService],
})
export class HealthModule {}
