import type { Env } from '@asin-monitor/config';
import type { SpApiConfigurationRepositoryPort } from '@asin-monitor/db';
import { NodeHttpTransport, type Logger } from '@asin-monitor/sp-api';
import { Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import { RedisModule } from '../redis/redis.module';
import { ApplicationRedisClient } from '../redis/redis.service';
import {
  ApplicationSpApiConfigSource,
  SpApiConfigModule,
} from '../sp-api-config/sp-api-config.module';
import {
  SP_API_CONFIG_ENV,
  SP_API_CONFIG_REPOSITORY,
} from '../sp-api-config/sp-api-config.service';
import { ApplicationSpApiRuntime } from './sp-api-runtime';
import { SpApiStatusController } from './sp-api-status.controller';
import { SpApiStatusService } from './sp-api-status.service';

export const SP_API_QUOTA_ENV = Symbol('SP_API_QUOTA_ENV');
const quotaKeys = [
  'RATE_LIMITER_KEY_PREFIX',
  'SP_API_RATE_LIMIT_PER_MINUTE',
  'SP_API_RATE_LIMIT_PER_HOUR',
  'SP_API_RATE_LIMIT_SAFETY_FACTOR',
  'SP_API_RATE_LIMIT_BURST_CAP',
];
@Injectable()
export class SpApiHttpTransport
  extends NodeHttpTransport
  implements OnApplicationShutdown
{
  constructor() {
    super({
      timeoutMs: 30000,
      maxResponseBytes: 8 * 1024 * 1024,
      maxInFlight: 64,
    });
  }
  onApplicationShutdown() {
    this.close();
  }
}
@Injectable()
export class SpApiHtmlHttpTransport
  extends NodeHttpTransport
  implements OnApplicationShutdown
{
  constructor() {
    super({
      timeoutMs: 15000,
      maxResponseBytes: 2 * 1024 * 1024,
      maxInFlight: 2,
    });
  }
  onApplicationShutdown() {
    this.close();
  }
}
@Module({
  imports: [AuthModule, RedisModule, SpApiConfigModule],
  controllers: [SpApiStatusController],
  providers: [
    SpApiStatusService,
    SpApiHttpTransport,
    SpApiHtmlHttpTransport,
    {
      provide: SP_API_QUOTA_ENV,
      inject: [ENV],
      useFactory: (_env: Env) =>
        Object.freeze(
          Object.fromEntries(
            quotaKeys
              .filter((key) => process.env[key] !== undefined)
              .map((key) => [key, process.env[key]]),
          ),
        ),
    },
    {
      provide: ApplicationSpApiRuntime,
      inject: [
        ENV,
        SP_API_CONFIG_ENV,
        SP_API_QUOTA_ENV,
        SP_API_CONFIG_REPOSITORY,
        ApplicationSpApiConfigSource,
        ApplicationRedisClient,
        AppLogger,
        SpApiHttpTransport,
        SpApiHtmlHttpTransport,
      ],
      useFactory: (
        env: Env,
        configEnv: Readonly<Record<string, unknown>>,
        quotaEnv: Readonly<Record<string, unknown>>,
        repository: SpApiConfigurationRepositoryPort,
        source: ApplicationSpApiConfigSource,
        redis: ApplicationRedisClient,
        appLogger: AppLogger,
        transport: SpApiHttpTransport,
        htmlTransport: SpApiHtmlHttpTransport,
      ) => {
        const logger: Logger = {
          debug: (message, context) =>
            appLogger.debug(message, 'SpApiRuntime', context),
          info: (message, context) =>
            appLogger.info(message, 'SpApiRuntime', context),
          warn: (message, context) =>
            appLogger.warn(message, 'SpApiRuntime', context),
          error: (message, context) =>
            appLogger.error(message, 'SpApiRuntime', context),
        };
        return new ApplicationSpApiRuntime({
          env,
          configEnv,
          quotaEnv,
          repository,
          source,
          redis,
          logger,
          transport,
          htmlTransport,
        });
      },
    },
  ],
  exports: [ApplicationSpApiRuntime],
})
export class SpApiRuntimeModule {}
