import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ImportStorageModule } from '../import/import-storage.module';
import { WebSocketModule } from '../websocket/websocket.module';
import { TaskCancellationController } from './task-cancellation.controller';
import { TaskCancellationService } from './task-cancellation.service';
import { TaskDownloadController, TaskDownloadService } from './task-download';
import { TaskQueryController } from './task-query.controller';
import { TaskQueryRuntime } from './task-query.runtime';
import { TaskQueryService } from './task-query.service';

@Module({
  imports: [AuthModule, WebSocketModule, ImportStorageModule],
  controllers: [
    TaskQueryController,
    TaskCancellationController,
    TaskDownloadController,
  ],
  providers: [
    TaskQueryRuntime,
    TaskQueryService,
    TaskCancellationService,
    TaskDownloadService,
  ],
  exports: [TaskQueryRuntime],
})
export class TaskQueryModule {}
