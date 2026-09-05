import { Module } from '@nestjs/common';

import type { Env } from '@asin-monitor/config';
import {
  BoundedAuthRepository,
  LegacyMysqlAuthRepository,
  PgLoginRepository,
  type AuthDataRepository,
} from '@asin-monitor/db';
import { ENV } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { ApplicationDatabasePools } from '../database/database.service';
import { AppLogger } from '../logger/app-logger.service';
import { RedisModule } from '../redis/redis.module';
import { AUTH_DATA_REPOSITORY } from './auth.constants';
import { AuthController } from './auth.controller';
import { AuthenticationGuard } from './authentication.guard';
import { AuthenticationService } from './authentication.service';
import { LoginController } from './login.controller';
import {
  LOGIN_REPOSITORY,
  LoginService,
  PASSWORD_COMPARER,
  comparePassword,
} from './login.service';
import { PermissionCacheService } from './permission-cache.service';
import { PermissionsGuard } from './permissions.guard';

export function createAuthDataRepository(
  env: Env,
  pools: ApplicationDatabasePools,
  logger: AppLogger,
): AuthDataRepository {
  if (env.AUTH_DATA_AUTHORITY === 'postgresql') {
    logger.info('鉴权数据权威源已选择', 'AuthModule', {
      source: 'postgresql',
    });
    return new BoundedAuthRepository(pools.primaryPool);
  }
  logger.info('鉴权数据权威源已选择', 'AuthModule', {
    source: 'legacy_mysql',
  });
  return new LegacyMysqlAuthRepository({
    host: env.DB_HOST!,
    port: env.DB_PORT,
    user: env.DB_USER!,
    password: env.DB_PASSWORD!,
    database: env.DB_NAME!,
    connectionLimit: env.DB_CONNECTION_LIMIT,
    connectTimeoutMs: env.DB_CONNECT_TIMEOUT,
    queryTimeoutMs: env.DB_QUERY_TIMEOUT,
  });
}

@Module({
  imports: [DatabaseModule, RedisModule],
  controllers: [AuthController, LoginController],
  providers: [
    {
      provide: LOGIN_REPOSITORY,
      inject: [ApplicationDatabasePools],
      useFactory: (pools: ApplicationDatabasePools) =>
        new PgLoginRepository(pools.primaryPool),
    },
    { provide: PASSWORD_COMPARER, useValue: comparePassword },
    LoginService,
    {
      provide: AUTH_DATA_REPOSITORY,
      inject: [ENV, ApplicationDatabasePools, AppLogger],
      useFactory: createAuthDataRepository,
    },
    AuthenticationService,
    AuthenticationGuard,
    PermissionCacheService,
    PermissionsGuard,
  ],
  exports: [
    AuthenticationService,
    AuthenticationGuard,
    PermissionCacheService,
    PermissionsGuard,
  ],
})
export class AuthModule {}
