import { Module } from '@nestjs/common';

import { ConfigModule } from './config/config.module';
import { HealthModule } from './health/health.module';
import { LoggerModule } from './logger/logger.module';
import { MetricsModule } from './metrics/metrics.module';

@Module({
  imports: [ConfigModule, LoggerModule, MetricsModule, HealthModule],
})
export class AppModule {}
