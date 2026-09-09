import {
  PgAsinBatchDeleteRepository,
  PgAsinQueryRepository,
  PgAsinWriteRepository,
} from '@asin-monitor/db';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ApplicationDatabasePools } from '../database/database.service';
import { TaskQueryModule } from '../tasks/task-query.module';
import { AsinBatchDeleteController } from './asin-batch-delete.controller';
import {
  ASIN_BATCH_DELETE_REPOSITORY,
  AsinBatchDeleteService,
} from './asin-batch-delete.service';
import { AsinQueryController } from './asin-query.controller';
import { ASIN_QUERY_REPOSITORY, AsinQueryService } from './asin-query.service';
import { AsinWriteController } from './asin-write.controller';
import { ASIN_WRITE_REPOSITORY, AsinWriteService } from './asin-write.service';

@Module({
  imports: [AuthModule, DatabaseModule, TaskQueryModule],
  controllers: [
    AsinQueryController,
    AsinWriteController,
    AsinBatchDeleteController,
  ],
  providers: [
    AsinQueryService,
    AsinWriteService,
    AsinBatchDeleteService,
    {
      provide: ASIN_BATCH_DELETE_REPOSITORY,
      inject: [ApplicationDatabasePools],
      useFactory: (pools: ApplicationDatabasePools) =>
        new PgAsinBatchDeleteRepository(pools.primaryPool),
    },
    {
      provide: ASIN_WRITE_REPOSITORY,
      inject: [ApplicationDatabasePools],
      useFactory: (pools: ApplicationDatabasePools) =>
        new PgAsinWriteRepository(pools.primaryPool),
    },
    {
      provide: ASIN_QUERY_REPOSITORY,
      inject: [ApplicationDatabasePools],
      useFactory: (pools: ApplicationDatabasePools) =>
        new PgAsinQueryRepository(pools.primaryPool),
    },
  ],
})
export class AsinModule {}
