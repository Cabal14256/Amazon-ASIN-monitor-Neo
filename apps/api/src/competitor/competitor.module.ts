import {
  PgCompetitorBatchDeleteRepository,
  PgCompetitorHistoryQueryRepository,
  PgCompetitorImportRepository,
  PgCompetitorQueryRepository,
  PgCompetitorWriteRepository,
} from '@asin-monitor/db';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ApplicationDatabasePools } from '../database/database.service';
import { ImportStorageModule } from '../import/import-storage.module';
import { TaskQueryModule } from '../tasks/task-query.module';
import { CompetitorBatchDeleteController } from './competitor-batch-delete.controller';
import {
  COMPETITOR_BATCH_DELETE_REPOSITORY,
  CompetitorBatchDeleteService,
} from './competitor-batch-delete.service';
import { CompetitorHistoryController } from './competitor-history.controller';
import {
  COMPETITOR_HISTORY_REPOSITORY,
  CompetitorHistoryService,
} from './competitor-history.service';
import { CompetitorImportController } from './competitor-import.controller';
import {
  COMPETITOR_IMPORT_REPOSITORY,
  CompetitorImportService,
} from './competitor-import.service';
import { CompetitorQueryController } from './competitor-query.controller';
import {
  COMPETITOR_QUERY_REPOSITORY,
  CompetitorQueryService,
} from './competitor-query.service';
import { CompetitorWriteController } from './competitor-write.controller';
import {
  COMPETITOR_WRITE_REPOSITORY,
  CompetitorWriteService,
} from './competitor-write.service';

@Module({
  imports: [AuthModule, DatabaseModule, TaskQueryModule, ImportStorageModule],
  controllers: [
    CompetitorQueryController,
    CompetitorWriteController,
    CompetitorBatchDeleteController,
    CompetitorImportController,
    CompetitorHistoryController,
  ],
  providers: [
    CompetitorQueryService,
    CompetitorWriteService,
    CompetitorBatchDeleteService,
    CompetitorImportService,
    CompetitorHistoryService,
    {
      provide: COMPETITOR_HISTORY_REPOSITORY,
      inject: [ApplicationDatabasePools],
      useFactory: (pools: ApplicationDatabasePools) =>
        new PgCompetitorHistoryQueryRepository(
          pools.primaryPool,
          pools.competitorPool,
        ),
    },
    {
      provide: COMPETITOR_IMPORT_REPOSITORY,
      inject: [ApplicationDatabasePools],
      useFactory: (pools: ApplicationDatabasePools) =>
        new PgCompetitorImportRepository(
          pools.primaryPool,
          pools.competitorPool,
        ),
    },
    {
      provide: COMPETITOR_BATCH_DELETE_REPOSITORY,
      inject: [ApplicationDatabasePools],
      useFactory: (pools: ApplicationDatabasePools) =>
        new PgCompetitorBatchDeleteRepository(
          pools.primaryPool,
          pools.competitorPool,
        ),
    },
    {
      provide: COMPETITOR_WRITE_REPOSITORY,
      inject: [ApplicationDatabasePools],
      useFactory: (pools: ApplicationDatabasePools) =>
        new PgCompetitorWriteRepository(
          pools.primaryPool,
          pools.competitorPool,
        ),
    },
    {
      provide: COMPETITOR_QUERY_REPOSITORY,
      inject: [ApplicationDatabasePools],
      useFactory: (pools: ApplicationDatabasePools) =>
        new PgCompetitorQueryRepository(
          pools.primaryPool,
          pools.competitorPool,
        ),
    },
  ],
})
export class CompetitorModule {}
