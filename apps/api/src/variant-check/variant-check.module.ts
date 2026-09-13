import { getNeoQueuePrefix, type Env } from '@asin-monitor/config';
import type { VariantCheckRepositoryPort } from '@asin-monitor/db';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import { RedisModule } from '../redis/redis.module';
import { ApplicationRedisClient } from '../redis/redis.service';
import { ApplicationSpApiRuntime } from '../sp-api-runtime/sp-api-runtime';
import { SpApiRuntimeModule } from '../sp-api-runtime/sp-api-runtime.module';
import { TaskQueryModule } from '../tasks/task-query.module';
import {
  VARIANT_CHECK_REPOSITORY,
  VariantCheckStorageModule,
} from './variant-check-storage.module';
import {
  OptionalCheckAuthentication,
  VariantCheckController,
} from './variant-check.controller';
import { ApplicationVariantCheckRuntime } from './variant-check.runtime';
import { VariantCheckService } from './variant-check.service';

@Module({
  imports: [
    AuthModule,
    VariantCheckStorageModule,
    SpApiRuntimeModule,
    TaskQueryModule,
    RedisModule,
  ],
  controllers: [VariantCheckController],
  providers: [
    VariantCheckService,
    OptionalCheckAuthentication,
    {
      provide: ApplicationVariantCheckRuntime,
      inject: [
        ENV,
        VARIANT_CHECK_REPOSITORY,
        ApplicationSpApiRuntime,
        ApplicationRedisClient,
        AppLogger,
      ],
      useFactory: (
        env: Env,
        repository: VariantCheckRepositoryPort,
        spApi: ApplicationSpApiRuntime,
        redis: ApplicationRedisClient,
        log: AppLogger,
      ) =>
        new ApplicationVariantCheckRuntime({
          repository,
          spApi,
          redis: redis.client,
          prefix: getNeoQueuePrefix(env),
          batchThreshold: env.MONITOR_BATCH_ASIN_THRESHOLD,
          batchConcurrency: env.BATCH_CHECK_GROUP_CONCURRENCY,
          logger: {
            debug: (message, context) =>
              log.debug(message, 'VariantCheckRuntime', context),
            info: (message, context) =>
              log.info(message, 'VariantCheckRuntime', context),
            warn: (message, context) =>
              log.warn(message, 'VariantCheckRuntime', context),
            error: (message, context) =>
              log.error(message, 'VariantCheckRuntime', context),
          },
        }),
    },
  ],
  exports: [ApplicationVariantCheckRuntime],
})
export class VariantCheckModule {}
