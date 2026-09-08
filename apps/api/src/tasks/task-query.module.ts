import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TaskQueryController } from './task-query.controller';
import { TaskQueryRuntime } from './task-query.runtime';
import { TaskQueryService } from './task-query.service';

@Module({
  imports: [AuthModule],
  controllers: [TaskQueryController],
  providers: [TaskQueryRuntime, TaskQueryService],
})
export class TaskQueryModule {}
