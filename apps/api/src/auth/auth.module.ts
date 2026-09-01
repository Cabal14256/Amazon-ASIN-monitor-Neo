import { Module } from '@nestjs/common';

import { AuthRepository } from '@asin-monitor/db';
import { DatabaseModule } from '../database/database.module';
import { ApplicationDatabasePools } from '../database/database.service';
import { RedisModule } from '../redis/redis.module';
import { AUTH_DATA_REPOSITORY } from './auth.constants';
import { AuthController } from './auth.controller';
import { AuthenticationGuard } from './authentication.guard';
import { AuthenticationService } from './authentication.service';
import { PermissionCacheService } from './permission-cache.service';
import { PermissionsGuard } from './permissions.guard';

@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [AuthController],
  providers: [
    {
      provide: AUTH_DATA_REPOSITORY,
      inject: [ApplicationDatabasePools],
      useFactory: (pools: ApplicationDatabasePools) =>
        new AuthRepository(pools.primaryDb),
    },
    AuthenticationService,
    AuthenticationGuard,
    PermissionCacheService,
    PermissionsGuard,
  ],
  exports: [AuthenticationGuard, PermissionCacheService, PermissionsGuard],
})
export class AuthModule {}
