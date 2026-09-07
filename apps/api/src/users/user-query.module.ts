import { PgUserQueryRepository } from '@asin-monitor/db';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ApplicationDatabasePools } from '../database/database.service';
import { UserQueryController } from './user-query.controller';
import { USER_QUERY_REPOSITORY, UserQueryService } from './user-query.service';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [UserQueryController],
  providers: [
    UserQueryService,
    {
      provide: USER_QUERY_REPOSITORY,
      inject: [ApplicationDatabasePools],
      useFactory: (pools: ApplicationDatabasePools) =>
        new PgUserQueryRepository(pools.primaryPool),
    },
  ],
})
export class UserQueryModule {}
