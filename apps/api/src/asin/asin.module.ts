import {
  PgAsinBatchDeleteRepository,
  PgAsinImportRepository,
  PgAsinQueryRepository,
  PgAsinWriteRepository,
} from '@asin-monitor/db';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ApplicationDatabasePools } from '../database/database.service';
import { ImportStorageModule } from '../import/import-storage.module';
import { TaskQueryModule } from '../tasks/task-query.module';
import { AsinBatchDeleteController } from './asin-batch-delete.controller';
import {
  ASIN_BATCH_DELETE_REPOSITORY,
  AsinBatchDeleteService,
} from './asin-batch-delete.service';
import { AsinImportController } from './asin-import.controller';
import {
  ASIN_IMPORT_REPOSITORY,
  AsinImportService,
} from './asin-import.service';
import { AsinQueryController } from './asin-query.controller';
import { ASIN_QUERY_REPOSITORY, AsinQueryService } from './asin-query.service';
import { AsinWriteController } from './asin-write.controller';
import { ASIN_WRITE_REPOSITORY, AsinWriteService } from './asin-write.service';

@Module({
  imports: [AuthModule, DatabaseModule, TaskQueryModule, ImportStorageModule],
  controllers: [
    AsinQueryController,
    AsinWriteController,
    AsinBatchDeleteController,
    AsinImportController,
  ],
  providers: [
    AsinQueryService,
    AsinWriteService,
    AsinBatchDeleteService,
    AsinImportService,
    {
      provide: ASIN_IMPORT_REPOSITORY,
      inject: [ApplicationDatabasePools],
      useFactory: (pools: ApplicationDatabasePools) =>
        new PgAsinImportRepository(pools.primaryPool),
    },
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
