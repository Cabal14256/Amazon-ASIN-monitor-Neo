import { PgUserAdministrationRepository } from '@asin-monitor/db';
import { Module } from '@nestjs/common';
import { hashPassword } from '../auth/account.service';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ApplicationDatabasePools } from '../database/database.service';
import { UserAdministrationController } from './user-administration.controller';
import {
  USER_ADMINISTRATION_HASHER,
  USER_ADMINISTRATION_REPOSITORY,
  UserAdministrationService,
} from './user-administration.service';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [UserAdministrationController],
  providers: [
    UserAdministrationService,
    { provide: USER_ADMINISTRATION_HASHER, useValue: hashPassword },
    {
      provide: USER_ADMINISTRATION_REPOSITORY,
      inject: [ApplicationDatabasePools],
      useFactory: (pools: ApplicationDatabasePools) =>
        new PgUserAdministrationRepository(pools.primaryPool),
    },
  ],
})
export class UserAdministrationModule {}
