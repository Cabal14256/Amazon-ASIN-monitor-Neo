import { PgMonitorHistoryQueryRepository } from '@asin-monitor/db';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ApplicationDatabasePools } from '../database/database.service';
import { MonitorHistoryController } from './monitor-history.controller';
import {
  MONITOR_HISTORY_REPOSITORY,
  MonitorHistoryService,
} from './monitor-history.service';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [MonitorHistoryController],
  providers: [
    MonitorHistoryService,
    {
      provide: MONITOR_HISTORY_REPOSITORY,
      inject: [ApplicationDatabasePools],
      useFactory: (pools: ApplicationDatabasePools) =>
        new PgMonitorHistoryQueryRepository(pools.primaryPool),
    },
  ],
})
export class MonitorHistoryModule {}
