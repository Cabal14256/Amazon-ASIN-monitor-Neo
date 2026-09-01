import { Module } from '@nestjs/common';

import type { Env } from '@asin-monitor/config';
import {
  AuthRepository,
  LegacyMysqlSessionRepository,
  type AuthSessionRepository,
} from '@asin-monitor/db';
import { ENV } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { ApplicationDatabasePools } from '../database/database.service';
import { AppLogger } from '../logger/app-logger.service';
import { RedisModule } from '../redis/redis.module';
import {
  AUTH_DATA_REPOSITORY,
  AUTH_SESSION_REPOSITORY,
  type AuthRepositoryPort,
} from './auth.constants';
import { AuthController } from './auth.controller';
import { AuthenticationGuard } from './authentication.guard';
import { AuthenticationService } from './authentication.service';
import { PermissionCacheService } from './permission-cache.service';
import { PermissionsGuard } from './permissions.guard';

export function createAuthSessionRepository(
  env: Env,
  postgresRepository: AuthRepositoryPort,
  logger: AppLogger,
): AuthSessionRepository {
  if (env.AUTH_SESSION_AUTHORITY === 'postgresql') {
    logger.info('Session 权威源已选择', 'AuthModule', {
      source: 'postgresql',
    });
    return postgresRepository;
  }
  logger.info('Session 权威源已选择', 'AuthModule', {
    source: 'legacy_mysql',
  });
  return new LegacyMysqlSessionRepository({
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
  controllers: [AuthController],
  providers: [
    {
      provide: AUTH_DATA_REPOSITORY,
      inject: [ApplicationDatabasePools],
      useFactory: (pools: ApplicationDatabasePools) =>
        new AuthRepository(pools.primaryDb),
    },
    {
      provide: AUTH_SESSION_REPOSITORY,
      inject: [ENV, AUTH_DATA_REPOSITORY, AppLogger],
      useFactory: createAuthSessionRepository,
    },
    AuthenticationService,
    AuthenticationGuard,
    PermissionCacheService,
    PermissionsGuard,
  ],
  exports: [AuthenticationGuard, PermissionCacheService, PermissionsGuard],
})
export class AuthModule {}
