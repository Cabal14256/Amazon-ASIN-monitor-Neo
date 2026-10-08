import { PgHomeWorkbenchQueryRepository } from '@asin-monitor/db';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ApplicationDatabasePools } from '../database/database.service';
import { HomeWorkbenchController } from './home-workbench.controller';
import { HomeWorkbenchGuard } from './home-workbench.guard';
import {
  HOME_WORKBENCH_REPOSITORY,
  HomeWorkbenchService,
} from './home-workbench.service';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [HomeWorkbenchController],
  providers: [
    HomeWorkbenchGuard,
    HomeWorkbenchService,
    {
      provide: HOME_WORKBENCH_REPOSITORY,
      inject: [ApplicationDatabasePools],
      useFactory: (pools: ApplicationDatabasePools) =>
        new PgHomeWorkbenchQueryRepository(pools.primaryPool),
    },
  ],
})
export class HomeWorkbenchModule {}
