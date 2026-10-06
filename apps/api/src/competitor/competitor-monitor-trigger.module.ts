import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CatalogOperationModule } from '../catalog/catalog-operation.module';
import { SpApiConfigModule } from '../sp-api-config/sp-api-config.module';
import { TaskQueryModule } from '../tasks/task-query.module';
import { CompetitorMonitorTriggerController } from './competitor-monitor-trigger.controller';
import { CompetitorMonitorTriggerService } from './competitor-monitor-trigger.service';

@Module({
  imports: [
    AuthModule,
    CatalogOperationModule,
    SpApiConfigModule,
    TaskQueryModule,
  ],
  controllers: [CompetitorMonitorTriggerController],
  providers: [CompetitorMonitorTriggerService],
})
export class CompetitorMonitorTriggerModule {}
