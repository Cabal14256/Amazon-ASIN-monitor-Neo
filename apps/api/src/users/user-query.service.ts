import type { Env } from '@asin-monitor/config';
import { userStatusSchema } from '@asin-monitor/contracts';
import type { AuthUserRecord, UserQueryRepositoryPort } from '@asin-monitor/db';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { publicUser } from '../auth/auth.controller';
import { normalizeUserStatus } from '../auth/authentication.service';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';

export const USER_QUERY_REPOSITORY = Symbol('USER_QUERY_REPOSITORY');
const querySchema = z
  .object({
    username: z
      .string()
      .max(200)
      .refine((value) => !/[\x00-\x1f\x7f]/.test(value))
      .optional(),
    status: z.union([userStatusSchema, z.literal('')]).optional(),
    current: z.coerce.number().int().positive().safe().default(1),
    pageSize: z.coerce.number().int().positive().max(100).default(10),
  })
  .strict();
function fail(status: number, message: string): never {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage: message },
    status,
  );
}
function formatUser(user: AuthUserRecord) {
  return {
    ...publicUser({
      ...user,
      status: normalizeUserStatus(user.status, user.lockedUntil),
      forcePasswordChange: Boolean(user.forcePasswordChange),
    }),
    create_time: user.createTime?.toISOString() ?? null,
    update_time: user.updateTime?.toISOString() ?? null,
  };
}

@Injectable()
export class UserQueryService {
  private active = 0;
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(USER_QUERY_REPOSITORY)
    private readonly repository: UserQueryRepositoryPort,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  private async read<T>(
    operation: 'list' | 'detail',
    action: () => Promise<T>,
  ): Promise<T> {
    if (this.env.AUTH_DATA_AUTHORITY !== 'postgresql')
      fail(503, '鉴权权威源尚未切换，请使用现有用户管理入口');
    if (this.active >= 8) fail(429, '用户查询繁忙，请稍后再试');
    this.active++;
    try {
      return await action();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      this.logger.error('用户查询失败', 'UserQueryService', {
        operation,
        reason: 'user_query_failed',
      });
      return fail(500, '用户查询失败');
    } finally {
      this.active--;
    }
  }
  list(query: Record<string, unknown>) {
    if (Object.values(query).some((value) => typeof value !== 'string'))
      fail(400, '用户查询参数无效');
    const parsed = querySchema.safeParse(query);
    if (
      !parsed.success ||
      !Number.isSafeInteger((parsed.data.current - 1) * parsed.data.pageSize)
    )
      fail(400, '用户查询参数无效');
    return this.read('list', async () => {
      const result = await this.repository.list(parsed.data);
      const byUser = new Map<
        string,
        { id: string; code: string; name: string }[]
      >();
      for (const { userId, ...role } of result.roles) {
        const assigned = byUser.get(userId) ?? [];
        assigned.push(role);
        byUser.set(userId, assigned);
      }
      return {
        list: result.users.map((user) => ({
          ...formatUser(user),
          roles: byUser.get(user.id) ?? [],
        })),
        total: result.total,
      };
    });
  }
  detail(userId: string) {
    if (!userId || [...userId].length > 50 || /[\x00-\x1f\x7f]/.test(userId))
      fail(400, '用户ID格式无效');
    return this.read('detail', async () => {
      const result = await this.repository.detail(userId);
      if (!result) fail(404, '用户不存在');
      return {
        ...formatUser(result.user),
        roles: result.roles,
        permissions: result.permissions,
        statusHistory: result.statusHistory.map((row) => {
          const id = Number(row.id);
          if (!Number.isSafeInteger(id) || id < 1)
            throw new Error('Invalid history ID');
          return {
            id,
            user_id: row.userId,
            old_status: row.oldStatus,
            new_status: row.newStatus,
            reason: row.reason,
            changed_by: row.changedBy,
            created_at: row.createdAt?.toISOString() ?? null,
          };
        }),
      };
    });
  }
}
