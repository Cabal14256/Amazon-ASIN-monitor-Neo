import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { Env } from '@asin-monitor/config';
import {
  permissionCodeSchema,
  type PermissionCode,
} from '@asin-monitor/contracts';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import { ApplicationRedisClient } from '../redis/redis.service';
import {
  AUTH_DATA_REPOSITORY,
  type AuthRepositoryPort,
} from './auth.constants';

type CacheType = 'permissions' | 'roles';
interface MemoryEntry<T> {
  expiresAt: number;
  value: T;
}

const permissionsSchema = z.array(permissionCodeSchema);
const rolesSchema = z.array(z.string().trim().min(1));

@Injectable()
export class PermissionCacheService {
  private readonly permissions = new Map<
    string,
    MemoryEntry<PermissionCode[]>
  >();
  private readonly roles = new Map<string, MemoryEntry<string[]>>();

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(ApplicationRedisClient)
    private readonly redis: ApplicationRedisClient,
    @Inject(AUTH_DATA_REPOSITORY)
    private readonly repository: AuthRepositoryPort,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  private key(type: CacheType, userId: string): string {
    return type === 'roles'
      ? `neo:user:roles:${userId}`
      : `user:permissions:${userId}`;
  }

  private getMemory<T>(
    cache: Map<string, MemoryEntry<T>>,
    userId: string,
  ): T | undefined {
    const entry = cache.get(userId);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      cache.delete(userId);
      return undefined;
    }
    return entry.value;
  }

  private setMemory<T>(
    cache: Map<string, MemoryEntry<T>>,
    userId: string,
    value: T,
  ): void {
    cache.set(userId, {
      value,
      expiresAt:
        Date.now() + this.env.AUTH_PERMISSION_CACHE_TTL_SECONDS * 1_000,
    });
  }

  private async getRedis<T>(
    type: CacheType,
    userId: string,
    schema: z.ZodType<T>,
  ): Promise<T | undefined> {
    try {
      const raw = await this.redis.get(this.key(type, userId));
      if (raw === null) return undefined;
      const parsedJson: unknown = JSON.parse(raw);
      const parsed = schema.safeParse(parsedJson);
      if (parsed.success) return parsed.data;
      this.logger.warn('忽略无效的权限缓存数据', 'PermissionCacheService', {
        cacheType: type,
        reason: 'invalid_payload',
      });
      return undefined;
    } catch {
      this.logger.warn(
        'Redis 权限缓存读取失败，使用降级路径',
        'PermissionCacheService',
        {
          cacheType: type,
          reason: 'redis_unavailable',
        },
      );
      return undefined;
    }
  }

  private async setRedis(
    type: CacheType,
    userId: string,
    value: readonly string[],
  ): Promise<void> {
    try {
      await this.redis.setex(
        this.key(type, userId),
        this.env.AUTH_PERMISSION_CACHE_TTL_SECONDS,
        JSON.stringify(value),
      );
    } catch {
      this.logger.warn(
        'Redis 权限缓存写入失败，保留内存缓存',
        'PermissionCacheService',
        {
          cacheType: type,
          reason: 'redis_unavailable',
        },
      );
    }
  }

  async getPermissions(userId: string): Promise<PermissionCode[]> {
    const redisValue = await this.getRedis(
      'permissions',
      userId,
      permissionsSchema,
    );
    if (redisValue) {
      this.setMemory(this.permissions, userId, redisValue);
      return redisValue;
    }
    const memoryValue = this.getMemory(this.permissions, userId);
    if (memoryValue) {
      await this.setRedis('permissions', userId, memoryValue);
      return memoryValue;
    }

    const databaseValue = permissionsSchema.parse(
      await this.repository.getPermissionCodes(userId),
    );
    this.setMemory(this.permissions, userId, databaseValue);
    await this.setRedis('permissions', userId, databaseValue);
    return databaseValue;
  }

  async getRoles(userId: string): Promise<string[]> {
    const redisValue = await this.getRedis('roles', userId, rolesSchema);
    if (redisValue) {
      this.setMemory(this.roles, userId, redisValue);
      return redisValue;
    }
    const memoryValue = this.getMemory(this.roles, userId);
    if (memoryValue) {
      await this.setRedis('roles', userId, memoryValue);
      return memoryValue;
    }

    const databaseValue = rolesSchema.parse(
      await this.repository.getRoleCodes(userId),
    );
    this.setMemory(this.roles, userId, databaseValue);
    await this.setRedis('roles', userId, databaseValue);
    return databaseValue;
  }

  async clearUserCache(userId: string): Promise<void> {
    this.permissions.delete(userId);
    this.roles.delete(userId);
    try {
      await this.redis.del(
        this.key('permissions', userId),
        this.key('roles', userId),
      );
    } catch {
      this.logger.warn('Redis 用户权限缓存清理失败', 'PermissionCacheService', {
        reason: 'redis_unavailable',
      });
    }
  }
}
