import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { MetricsModule } from '../metrics/metrics.module';
import { RedisModule } from '../redis/redis.module';
import { HealthController } from './health.controller';
import {
  HealthErrorStatsService,
  HealthRuntimeDependencies,
  HealthService,
} from './health.service';

@Module({
  imports: [DatabaseModule, RedisModule, MetricsModule],
  controllers: [HealthController],
  providers: [
    HealthErrorStatsService,
    HealthRuntimeDependencies,
    HealthService,
  ],
  exports: [HealthErrorStatsService],
})
export class HealthModule {}
