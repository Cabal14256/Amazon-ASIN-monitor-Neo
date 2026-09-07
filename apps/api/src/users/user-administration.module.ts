import {
  PgUserAdministrationRepository,
  PgUserPasswordRepository,
} from '@asin-monitor/db';
import { Module } from '@nestjs/common';
import { hashPassword } from '../auth/account.service';
import { AuthModule } from '../auth/auth.module';
import { comparePassword } from '../auth/login.service';
import { DatabaseModule } from '../database/database.module';
import { ApplicationDatabasePools } from '../database/database.service';
import { UserAdministrationController } from './user-administration.controller';
import {
  USER_ADMINISTRATION_HASHER,
  USER_ADMINISTRATION_REPOSITORY,
  UserAdministrationService,
} from './user-administration.service';
import { UserPasswordController } from './user-password.controller';
import {
  USER_PASSWORD_COMPARER,
  USER_PASSWORD_HASHER,
  USER_PASSWORD_REPOSITORY,
  UserPasswordService,
} from './user-password.service';

@Module({
  imports: [AuthModule, DatabaseModule],
  controllers: [UserAdministrationController, UserPasswordController],
  providers: [
    UserPasswordService,
    { provide: USER_PASSWORD_HASHER, useValue: hashPassword },
    { provide: USER_PASSWORD_COMPARER, useValue: comparePassword },
    {
      provide: USER_PASSWORD_REPOSITORY,
      inject: [ApplicationDatabasePools],
      useFactory: (pools: ApplicationDatabasePools) =>
        new PgUserPasswordRepository(pools.primaryPool),
    },
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
