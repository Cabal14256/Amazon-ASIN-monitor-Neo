import { Global, Module } from '@nestjs/common';

import { ConfigModule } from '../config/config.module';
import { LoggerModule } from '../logger/logger.module';
import { MetricsModule } from '../metrics/metrics.module';
import { ApplicationDatabasePools } from './database.service';

@Global()
@Module({
  imports: [ConfigModule, LoggerModule, MetricsModule],
  providers: [ApplicationDatabasePools],
  exports: [ApplicationDatabasePools],
})
export class DatabaseModule {}
