import { Module } from '@nestjs/common';

import { MetricsModule } from '../metrics/metrics.module';
import { HealthController } from './health.controller';
import {
  ApplicationDatabasePools,
  HealthErrorStatsService,
  HealthRuntimeDependencies,
  HealthService,
} from './health.service';

@Module({
  imports: [MetricsModule],
  controllers: [HealthController],
  providers: [
    ApplicationDatabasePools,
    HealthErrorStatsService,
    HealthRuntimeDependencies,
    HealthService,
  ],
  exports: [ApplicationDatabasePools, HealthErrorStatsService],
})
export class HealthModule {}
