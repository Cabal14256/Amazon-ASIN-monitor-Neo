import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TaskQueryModule } from '../tasks/task-query.module';
import { VariantCheckStorageModule } from '../variant-check/variant-check-storage.module';
import { MonitorTriggerController } from './monitor-trigger.controller';
import { MonitorTriggerService } from './monitor-trigger.service';

@Module({
  imports: [AuthModule, TaskQueryModule, VariantCheckStorageModule],
  controllers: [MonitorTriggerController],
  providers: [MonitorTriggerService],
})
export class MonitorTriggerModule {}
