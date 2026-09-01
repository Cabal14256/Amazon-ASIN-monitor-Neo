import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';

import type { Env } from '@asin-monitor/config';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';

/** API 进程共享的 Redis 客户端。 */
@Injectable()
export class ApplicationRedisClient implements OnModuleDestroy {
  readonly client: Redis;
  private connectPromise: Promise<void> | undefined;

  constructor(@Inject(ENV) env: Env, @Inject(AppLogger) logger: AppLogger) {
    this.client = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: env.HEALTH_PROBE_TIMEOUT_MS,
      commandTimeout: env.HEALTH_PROBE_TIMEOUT_MS,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    this.client.on('error', () => {
      logger.debug('Redis 底层连接事件', 'ApplicationRedisClient', {
        dependency: 'redis',
        reason: 'connection_error',
      });
    });
  }

  private async ensureConnected(): Promise<void> {
    if (this.connectPromise) {
      await this.connectPromise;
      return;
    }
    if (this.client.status !== 'wait' && this.client.status !== 'end') return;

    const connectPromise = this.client.connect().then(() => undefined);
    this.connectPromise = connectPromise;
    try {
      await connectPromise;
    } finally {
      if (this.connectPromise === connectPromise) {
        this.connectPromise = undefined;
      }
    }
  }

  async ping(): Promise<void> {
    await this.ensureConnected();
    await this.client.ping();
  }

  async get(key: string): Promise<string | null> {
    await this.ensureConnected();
    return this.client.get(key);
  }

  async setex(key: string, ttlSeconds: number, value: string): Promise<void> {
    await this.ensureConnected();
    await this.client.setex(key, ttlSeconds, value);
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    await this.ensureConnected();
    return this.client.del(...keys);
  }

  onModuleDestroy(): void {
    this.client.disconnect(false);
  }
}
