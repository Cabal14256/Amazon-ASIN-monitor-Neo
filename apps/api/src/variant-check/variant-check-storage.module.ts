import { PgVariantCheckRepository } from '@asin-monitor/db';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ApplicationDatabasePools } from '../database/database.service';

export const VARIANT_CHECK_REPOSITORY = Symbol('VARIANT_CHECK_REPOSITORY');
@Module({
  imports: [DatabaseModule],
  providers: [
    {
      provide: VARIANT_CHECK_REPOSITORY,
      inject: [ApplicationDatabasePools],
      useFactory: (pools: ApplicationDatabasePools) =>
        new PgVariantCheckRepository(pools.primaryPool),
    },
  ],
  exports: [VARIANT_CHECK_REPOSITORY],
})
export class VariantCheckStorageModule {}
