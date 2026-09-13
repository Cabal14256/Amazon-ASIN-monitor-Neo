import type { Env } from '@asin-monitor/config';
import {
  PgMonitorAnalyticsQueryRepository,
  PgMonitorHistoryQueryRepository,
} from '@asin-monitor/db';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ENV } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { ApplicationDatabasePools } from '../database/database.service';
import { AppLogger } from '../logger/app-logger.service';
import { MonitorAnalyticsCache } from './monitor-analytics-cache';
import { MonitorAnalyticsController } from './monitor-analytics.controller';
import { MonitorAnalyticsGuard } from './monitor-analytics.guard';
import {
  MONITOR_ANALYTICS_REPOSITORY,
  MonitorAnalyticsService,
} from './monitor-analytics.service';
import { MonitorHistoryController } from './monitor-history.controller';
import {
  MONITOR_HISTORY_REPOSITORY,
  MonitorHistoryService,
} from './monitor-history.service';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [MonitorHistoryController, MonitorAnalyticsController],
  providers: [
    MonitorHistoryService,
    MonitorAnalyticsService,
    MonitorAnalyticsGuard,
    MonitorAnalyticsCache,
    {
      provide: MONITOR_ANALYTICS_REPOSITORY,
      inject: [ApplicationDatabasePools, ENV, AppLogger],
      useFactory: (
        pools: ApplicationDatabasePools,
        env: Env,
        logger: AppLogger,
      ) =>
        new PgMonitorAnalyticsQueryRepository(pools.primaryPool, {
          aggregateEnabled: env.ANALYTICS_AGG_ENABLED,
          intervalEnabled: env.ANALYTICS_STATUS_INTERVAL_ENABLED,
          onAggregateFallback: (reason) =>
            logger.warn('统计聚合回退原始数据', 'MonitorAnalyticsRepository', {
              reason,
            }),
          onIntervalFallback: (reason) =>
            logger.warn('统计区间回退原始数据', 'MonitorAnalyticsRepository', {
              reason,
            }),
        }),
    },
    {
      provide: MONITOR_HISTORY_REPOSITORY,
      inject: [ApplicationDatabasePools],
      useFactory: (pools: ApplicationDatabasePools) =>
        new PgMonitorHistoryQueryRepository(pools.primaryPool),
    },
  ],
})
export class MonitorHistoryModule {}
