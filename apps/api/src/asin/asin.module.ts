import { PgAsinQueryRepository, PgAsinWriteRepository } from '@asin-monitor/db';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ApplicationDatabasePools } from '../database/database.service';
import { AsinQueryController } from './asin-query.controller';
import { ASIN_QUERY_REPOSITORY, AsinQueryService } from './asin-query.service';
import { AsinWriteController } from './asin-write.controller';
import { ASIN_WRITE_REPOSITORY, AsinWriteService } from './asin-write.service';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [AsinQueryController, AsinWriteController],
  providers: [
    AsinQueryService,
    AsinWriteService,
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
