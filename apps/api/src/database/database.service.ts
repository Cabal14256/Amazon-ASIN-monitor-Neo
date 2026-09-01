import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Pool } from 'pg';

import type { Env } from '@asin-monitor/config';
import { createDb, createPgPool, type Db } from '@asin-monitor/db';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';

export type DatabaseName = 'competitor_database' | 'database';

/** API 进程唯一的双 PostgreSQL 连接池与 Drizzle 客户端。 */
@Injectable()
export class ApplicationDatabasePools implements OnModuleDestroy {
  readonly primaryPool: Pool;
  readonly competitorPool: Pool;
  readonly primaryDb: Db;
  readonly competitorDb: Db;

  constructor(@Inject(ENV) env: Env, @Inject(AppLogger) logger: AppLogger) {
    const poolOptions = {
      max: 10,
      connectionTimeoutMillis: env.DATABASE_POOL_CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: 30_000,
      application_name: 'amazon-asin-monitor-neo-api',
    };
    this.primaryPool = createPgPool(env.DATABASE_URL, poolOptions);
    this.competitorPool = createPgPool(
      env.COMPETITOR_DATABASE_URL,
      poolOptions,
    );
    this.primaryDb = createDb(this.primaryPool);
    this.competitorDb = createDb(this.competitorPool);
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

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([
      this.primaryPool.end(),
      this.competitorPool.end(),
    ]);
  }
}
