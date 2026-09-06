import {
  revokeSessionRequestSchema,
  type SessionRecord,
} from '@asin-monitor/contracts';
import type { SessionManagementRepositoryPort } from '@asin-monitor/db';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import { AppLogger } from '../logger/app-logger.service';
import { AUTH_DATA_REPOSITORY } from './auth.constants';

function failure(status: number, message: string) {
  return new HttpException(
    { success: false, errorCode: status, errorMessage: message },
    status,
  );
}

@Injectable()
export class SessionService {
  private active = 0;
  constructor(
    @Inject(AUTH_DATA_REPOSITORY)
    private readonly repository: SessionManagementRepositoryPort,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  private async run<T>(operation: string, read: () => Promise<T>): Promise<T> {
    if (this.active >= 8) throw failure(503, '会话管理暂时不可用');
    this.active++;
    try {
      return await read();
    } catch {
      this.logger.error('会话管理失败', 'SessionService', {
        operation,
        reason: 'session_dependency_error',
      });
      throw failure(500, '会话管理失败');
    } finally {
      this.active--;
    }
  }
  async list(userId: string): Promise<SessionRecord[]> {
    const rows = await this.run('list', () =>
      this.repository.listSessionsByUserId(userId),
    );
    return rows.map((row) => ({
      id: row.id,
      user_id: row.userId,
      user_agent: row.userAgent,
      ip_address: row.ipAddress,
      status: row.status,
      remember_me: row.rememberMe,
      created_at: row.createdAt.toISOString(),
      last_active_at: row.lastActiveAt.toISOString(),
      expires_at: row.expiresAt?.toISOString() ?? null,
    }));
  }
  async logout(userId: string, sessionId: string): Promise<void> {
    // Concurrent successful logout is idempotent after this request passed authentication.
    await this.run('logout', () =>
      this.repository.revokeOwnedSession(sessionId, userId),
    );
  }
  async revoke(userId: string, body: unknown): Promise<void> {
    const parsed = revokeSessionRequestSchema.safeParse(body);
    if (!parsed.success || parsed.data.sessionId.length > 36)
      throw failure(400, '缺少或无效的 sessionId');
    const revoked = await this.run('revoke', () =>
      this.repository.revokeOwnedSession(parsed.data.sessionId, userId),
    );
    if (!revoked) throw failure(404, '会话不存在或已被拒绝');
  }
}
