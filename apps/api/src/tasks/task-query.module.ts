import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ImportStorageModule } from '../import/import-storage.module';
import { VariantCheckStorageModule } from '../variant-check/variant-check-storage.module';
import { WebSocketModule } from '../websocket/websocket.module';
import {
  AsinExportTaskController,
  AsinExportTaskService,
} from './asin-export-task';
import { ExportStorageModule } from './export-storage.module';
import { TaskCancellationController } from './task-cancellation.controller';
import { TaskCancellationService } from './task-cancellation.service';
import { TaskDownloadController, TaskDownloadService } from './task-download';
import { TaskQueryController } from './task-query.controller';
import { TaskQueryRuntime } from './task-query.runtime';
import { TaskQueryService } from './task-query.service';
import { VariantCheckTaskResults } from './variant-check-task-results';

@Module({
  imports: [
    AuthModule,
    WebSocketModule,
    ImportStorageModule,
    VariantCheckStorageModule,
    ExportStorageModule,
  ],
  controllers: [
    TaskQueryController,
    TaskCancellationController,
    TaskDownloadController,
    AsinExportTaskController,
  ],
  providers: [
    TaskQueryRuntime,
    TaskQueryService,
    VariantCheckTaskResults,
    TaskCancellationService,
    TaskDownloadService,
    AsinExportTaskService,
  ],
  exports: [TaskQueryRuntime],
})
export class TaskQueryModule {}
