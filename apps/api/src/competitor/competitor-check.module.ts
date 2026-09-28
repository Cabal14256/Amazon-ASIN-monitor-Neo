import { getNeoQueuePrefix, type Env } from '@asin-monitor/config';
import type { CompetitorCheckRepositoryPort } from '@asin-monitor/db';
import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ENV } from '../config/config.module';
import { DatabaseModule } from '../database/database.module';
import { AppLogger } from '../logger/app-logger.service';
import { RedisModule } from '../redis/redis.module';
import { ApplicationRedisClient } from '../redis/redis.service';
import { ApplicationSpApiRuntime } from '../sp-api-runtime/sp-api-runtime';
import { SpApiRuntimeModule } from '../sp-api-runtime/sp-api-runtime.module';
import { TaskQueryModule } from '../tasks/task-query.module';
import {
  COMPETITOR_CHECK_REPOSITORY,
  CompetitorCheckStorageModule,
} from './competitor-check-storage.module';
import { CompetitorCheckController } from './competitor-check.controller';
import { ApplicationCompetitorCheckRuntime } from './competitor-check.runtime';
import { CompetitorCheckService } from './competitor-check.service';

@Module({
  imports: [
    AuthModule,
    DatabaseModule,
    TaskQueryModule,
    CompetitorCheckStorageModule,
    SpApiRuntimeModule,
    RedisModule,
  ],
  controllers: [CompetitorCheckController],
  providers: [
    CompetitorCheckService,
    {
      provide: ApplicationCompetitorCheckRuntime,
      inject: [
        ENV,
        COMPETITOR_CHECK_REPOSITORY,
        ApplicationSpApiRuntime,
        ApplicationRedisClient,
        AppLogger,
      ],
      useFactory: (
        env: Env,
        repository: CompetitorCheckRepositoryPort,
        spApi: ApplicationSpApiRuntime,
        redis: ApplicationRedisClient,
        log: AppLogger,
      ) =>
        new ApplicationCompetitorCheckRuntime({
          repository,
          spApi,
          redis: redis.client,
          prefix: getNeoQueuePrefix(env),
          logger: {
            debug: (message, context) =>
              log.debug(message, 'CompetitorCheckRuntime', context),
            info: (message, context) =>
              log.info(message, 'CompetitorCheckRuntime', context),
            warn: (message, context) =>
              log.warn(message, 'CompetitorCheckRuntime', context),
            error: (message, context) =>
              log.error(message, 'CompetitorCheckRuntime', context),
          },
        }),
    },
  ],
  exports: [ApplicationCompetitorCheckRuntime],
})
export class CompetitorCheckModule {}
