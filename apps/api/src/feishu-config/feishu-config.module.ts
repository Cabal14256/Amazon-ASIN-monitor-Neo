import { PgFeishuConfigurationRepository } from '@asin-monitor/db';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ApplicationDatabasePools } from '../database/database.service';
import { FeishuConfigController } from './feishu-config.controller';
import { FeishuConfigGuard } from './feishu-config.guard';
import {
  FEISHU_CONFIGURATION_REPOSITORY,
  FeishuConfigService,
} from './feishu-config.service';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [FeishuConfigController],
  providers: [
    FeishuConfigGuard,
    FeishuConfigService,
    {
      provide: FEISHU_CONFIGURATION_REPOSITORY,
      inject: [ApplicationDatabasePools],
      useFactory: (pools: ApplicationDatabasePools) =>
        new PgFeishuConfigurationRepository(pools.primaryPool),
    },
  ],
})
export class FeishuConfigModule {}
