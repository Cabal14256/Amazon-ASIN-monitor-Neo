import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WebSocketModule } from '../websocket/websocket.module';
import { TaskCancellationController } from './task-cancellation.controller';
import { TaskCancellationService } from './task-cancellation.service';
import { TaskQueryController } from './task-query.controller';
import { TaskQueryRuntime } from './task-query.runtime';
import { TaskQueryService } from './task-query.service';

@Module({
  imports: [AuthModule, WebSocketModule],
  controllers: [TaskQueryController, TaskCancellationController],
  providers: [TaskQueryRuntime, TaskQueryService, TaskCancellationService],
  exports: [TaskQueryRuntime],
})
export class TaskQueryModule {}
