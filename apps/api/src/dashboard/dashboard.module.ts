import { PgDashboardQueryRepository } from '@asin-monitor/db';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ApplicationDatabasePools } from '../database/database.service';
import { DashboardController } from './dashboard.controller';
import { DashboardGuard } from './dashboard.guard';
import { DASHBOARD_REPOSITORY, DashboardService } from './dashboard.service';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [DashboardController],
  providers: [
    DashboardGuard,
    DashboardService,
    {
      provide: DASHBOARD_REPOSITORY,
      inject: [ApplicationDatabasePools],
      useFactory: (pools: ApplicationDatabasePools) =>
        new PgDashboardQueryRepository(pools.primaryPool),
    },
  ],
})
export class DashboardModule {}
