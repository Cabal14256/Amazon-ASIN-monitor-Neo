import {
  Inject,
  Injectable,
  Optional,
  type OnApplicationShutdown,
} from '@nestjs/common';
import type { Pool } from 'pg';

import type { Env } from '@asin-monitor/config';
import {
  createDb,
  createPgPool,
  createShanghaiTimestampTypeOverrides,
  type Db,
} from '@asin-monitor/db';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import { MetricsService } from '../metrics/metrics.service';
import { observedPgClient } from './observed-pg-client';

export type DatabaseName = 'competitor_database' | 'database';

/** API 进程唯一的双 PostgreSQL 连接池与 Drizzle 客户端。 */
@Injectable()
export class ApplicationDatabasePools implements OnApplicationShutdown {
  readonly primaryPool: Pool;
  readonly competitorPool: Pool;
  readonly primaryDb: Db;
  readonly competitorDb: Db;
  private readonly detachMetrics?: () => void;

  constructor(
    @Inject(ENV) env: Env,
    @Inject(AppLogger) logger: AppLogger,
    @Optional() @Inject(MetricsService) metrics?: MetricsService,
  ) {
    const poolOptions = {
      max: 10,
      connectionTimeoutMillis: env.DATABASE_POOL_CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: 30_000,
      application_name: 'amazon-asin-monitor-neo-api',
      types: createShanghaiTimestampTypeOverrides(),
      ...(metrics
        ? {
            Client: observedPgClient(
              (operation, status, seconds) =>
                metrics.recordDatabaseQuery(operation, status, seconds),
              () =>
                logger.warn('数据库指标记录失败', 'ApplicationDatabasePools', {
                  reason: 'query_metrics_failed',
                }),
            ),
          }
        : {}),
    };
    this.primaryPool = createPgPool(env.DATABASE_URL, poolOptions);
    this.competitorPool = createPgPool(
      env.COMPETITOR_DATABASE_URL,
      poolOptions,
    );
    this.primaryDb = createDb(this.primaryPool);
    this.competitorDb = createDb(this.competitorPool);
    this.detachMetrics = metrics?.attachDatabasePools(
      {
        database: this.primaryPool,
        competitor_database: this.competitorPool,
      },
      () =>
        logger.warn('数据库连接池指标读取失败', 'ApplicationDatabasePools', {
          reason: 'pool_metrics_failed',
        }),
    );
    this.registerIdleErrorHandler(this.primaryPool, 'database', logger);
    this.registerIdleErrorHandler(
      this.competitorPool,
      'competitor_database',
      logger,
    );
  }

  private registerIdleErrorHandler(
    pool: Pool,
    dependency: DatabaseName,
    logger: AppLogger,
  ): void {
    pool.on('error', () => {
      logger.warn('PostgreSQL 空闲连接异常', 'ApplicationDatabasePools', {
        dependency,
        reason: 'idle_client_error',
      });
    });
  }

  /** 依赖模块最后关闭：HTTP drain 和审计 flush 期间保持数据库可用。 */
  async onApplicationShutdown(): Promise<void> {
    try {
      await Promise.allSettled([
        this.primaryPool.end(),
        this.competitorPool.end(),
      ]);
    } finally {
      this.detachMetrics?.();
    }
  }
}
