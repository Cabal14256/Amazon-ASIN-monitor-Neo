import { z } from 'zod';
import type { AppLogger } from '../logger/app-logger.service';
import type { ApplicationRedisClient } from '../redis/redis.service';

export const PG_PERMISSION_GENERATION_KEY = 'neo:auth:cache-generation';
export const ADVANCE_PERMISSION_GENERATION =
  "return redis.call('INCR', KEYS[1])";
type CacheType = 'permissions' | 'roles';
type Lookup<T> =
  | { state: 'hit'; value: T }
  | { state: 'miss'; key: string }
  | { state: 'unavailable' };

/** Isolated from Legacy cache keys. Old in-flight writes expire in an obsolete namespace. */
export class PostgresPermissionCache {
  private revision = 0;
  private acknowledgedRevision = 0;
  constructor(
    private readonly redis: ApplicationRedisClient,
    private readonly logger: AppLogger,
    private readonly ttlSeconds: number,
  ) {}

  private warn(reason: string) {
    this.logger.warn(
      'PostgreSQL 权限缓存使用降级路径',
      'PermissionCacheService',
      { reason },
    );
  }
  private async flush(revision: number): Promise<boolean> {
    try {
      const result = await this.redis.eval(
        ADVANCE_PERMISSION_GENERATION,
        [PG_PERMISSION_GENERATION_KEY],
        [],
      );
      if (
        typeof result !== 'number' ||
        !Number.isSafeInteger(result) ||
        result < 1
      )
        throw new Error('Invalid cache generation');
      this.acknowledgedRevision = Math.max(this.acknowledgedRevision, revision);
      return true;
    } catch {
      this.warn('generation_unavailable');
      return false;
    }
  }
  async clear(): Promise<void> {
    const revision = ++this.revision;
    await this.flush(revision);
  }
  private async lookup<T>(
    type: CacheType,
    userId: string,
    schema: z.ZodType<T>,
  ): Promise<Lookup<T>> {
    try {
      const generation =
        (await this.redis.get(PG_PERMISSION_GENERATION_KEY)) ?? '0';
      if (!/^\d{1,20}$/.test(generation))
        throw new Error('Invalid cache generation');
      const key = `neo:auth:${generation}:${type}:${userId}`;
      const raw = await this.redis.get(key);
      if (raw === null) return { state: 'miss', key };
      try {
        const parsed = schema.safeParse(JSON.parse(raw));
        if (parsed.success) return { state: 'hit', value: parsed.data };
      } catch {
        /* Treat invalid cache data as a miss. */
      }
      this.warn('invalid_payload');
      return { state: 'miss', key };
    } catch {
      this.warn('redis_unavailable');
      return { state: 'unavailable' };
    }
  }
  async read<T>(
    type: CacheType,
    userId: string,
    schema: z.ZodType<T>,
    loader: () => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const revision = this.revision;
      const dirty =
        this.acknowledgedRevision < revision && !(await this.flush(revision));
      const cached: Lookup<T> = dirty
        ? { state: 'unavailable' }
        : await this.lookup(type, userId, schema);
      if (revision !== this.revision) continue;
      if (cached.state === 'hit') {
        return cached.value;
      }
      // Authentication already requires PostgreSQL. On Redis failure, read the
      // authority again instead of granting a potentially revoked memory entry.
      const value = schema.parse(await loader());
      if (revision !== this.revision) continue;
      if (cached.state === 'miss') {
        try {
          await this.redis.setex(
            cached.key,
            this.ttlSeconds,
            JSON.stringify(value),
          );
        } catch {
          this.warn('redis_write_unavailable');
        }
      }
      if (revision === this.revision) return value;
    }
    throw new Error('Permission cache changed repeatedly');
  }
}
