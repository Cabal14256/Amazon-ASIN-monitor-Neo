import { PgCompetitorCheckRepository } from '@asin-monitor/db';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ApplicationDatabasePools } from '../database/database.service';

export const COMPETITOR_CHECK_REPOSITORY = Symbol(
  'COMPETITOR_CHECK_REPOSITORY',
);
@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: COMPETITOR_CHECK_REPOSITORY,
      inject: [ApplicationDatabasePools],
      useFactory: (pools: ApplicationDatabasePools) =>
        new PgCompetitorCheckRepository(
          pools.primaryPool,
          pools.competitorPool,
        ),
    },
  ],
  exports: [COMPETITOR_CHECK_REPOSITORY],
})
export class CompetitorCheckStorageModule {}
