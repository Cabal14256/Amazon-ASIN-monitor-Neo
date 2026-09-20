import { PgCompetitorQueryRepository } from '@asin-monitor/db';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ApplicationDatabasePools } from '../database/database.service';
import { CompetitorQueryController } from './competitor-query.controller';
import {
  COMPETITOR_QUERY_REPOSITORY,
  CompetitorQueryService,
} from './competitor-query.service';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [CompetitorQueryController],
  providers: [
    CompetitorQueryService,
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
