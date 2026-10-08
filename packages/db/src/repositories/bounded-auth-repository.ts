import type { Pool, PoolClient } from 'pg';
import { createDb, type Db } from '../client';
import type { CatalogPhysicalOutcome } from '../domain/catalog-operation';
import {
  AuthRepository,
  type AuthDataRepository,
  type SessionManagementRepositoryPort,
} from './auth-repository';

export class AuthQueryTimeoutError extends Error {
  readonly code = 'AUTH_QUERY_TIMEOUT';
  constructor() {
    super('Authentication database query timed out');
    this.name = 'AuthQueryTimeoutError';
  }
}

/** 只约束鉴权查询，不能给导出/分析共享池施加全局 statement_timeout。 */
export async function withAuthDatabaseDeadline<T>(
  pool: Pool,
  operation: (db: Db, ensureOpen: () => void) => Promise<T>,
  onPhysicalSettled?: (outcome: CatalogPhysicalOutcome) => Promise<void>,
): Promise<T> {
  // 获取连接由应用池的 connectionTimeoutMillis 约束。
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    // No business callback or SQL was started on this failed acquisition.
    await onPhysicalSettled?.('rolled-back');
    throw error;
  }
  let destroyed = false;
  let released = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let connectionError!: (error: Error) => void;
  const connectionFailure = new Promise<never>((_resolve, reject) => {
    connectionError = reject;
  });
  client.on('error', connectionError);
  const release = (discard: boolean) => {
    if (released) return;
    released = true;
    client.removeListener('error', connectionError);
    if (discard) client.release(true);
    else client.release();
  };
  const destroy = () => {
    if (!destroyed) {
      destroyed = true;
      release(true);
    }
  };
  const ensureOpen = () => {
    if (destroyed) throw new AuthQueryTimeoutError();
  };
  try {
    return await Promise.race([
      connectionFailure,
      (async () => {
        let commitStarted = false;
        let outcome: CatalogPhysicalOutcome = 'uncertain';
        try {
          await client.query('BEGIN');
          ensureOpen();
          await client.query('SET LOCAL statement_timeout = 1500');
          ensureOpen();
          const result = await operation(createDb(client), ensureOpen);
          ensureOpen();
          commitStarted = true;
          await client.query('COMMIT');
          ensureOpen();
          outcome = 'committed';
          return result;
        } catch (error) {
          // Destruction / an unacknowledged COMMIT is never a rollback proof.
          if (onPhysicalSettled && !destroyed && !commitStarted) {
            try {
              await client.query('ROLLBACK');
              ensureOpen();
              outcome = 'rolled-back';
            } catch {
              // Durable execution pin remains uncertain.
            }
          }
          throw error;
        } finally {
          // Return the actual SQL connection before pin settlement borrows the
          // same pool; otherwise a fully occupied pool could deadlock here.
          release(outcome === 'uncertain');
          // This belongs to the ACTUAL work promise, never Promise.race/finally.
          await onPhysicalSettled?.(outcome);
        }
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          // 销毁独占连接以中止未决 I/O，而不是仅丢弃 Promise 的结果。
          destroy();
          reject(new AuthQueryTimeoutError());
        }, 2000);
      }),
    ]);
  } catch (error) {
    destroy(); // 超时/SQL 失败的事务不能归还为可复用连接。
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
    client.removeListener('error', connectionError);
    if (!destroyed) release(false);
  }
}

/** API 鉴权专用包装，复用主池但每个操作占用独立、有截止时间的事务。 */
export class BoundedAuthRepository
  implements AuthDataRepository, SessionManagementRepositoryPort
{
  constructor(private readonly pool: Pool) {}
  private run<T>(
    operation: (repository: AuthRepository) => Promise<T>,
  ): Promise<T> {
    return withAuthDatabaseDeadline(this.pool, (db) =>
      operation(new AuthRepository(db)),
    );
  }
  findSessionById(id: string) {
    return this.run((repo) => repo.findSessionById(id));
  }
  revokeSession(id: string) {
    return this.run((repo) => repo.revokeSession(id));
  }
  listSessionsByUserId(userId: string) {
    return this.run((repo) => repo.listSessionsByUserId(userId));
  }
  revokeOwnedSession(sessionId: string, userId: string) {
    return this.run((repo) => repo.revokeOwnedSession(sessionId, userId));
  }
  touchSession(id: string) {
    return this.run((repo) => repo.touchSession(id));
  }
  findUserById(id: string) {
    return this.run((repo) => repo.findUserById(id));
  }
  markPasswordChangeRequired(id: string) {
    return this.run((repo) => repo.markPasswordChangeRequired(id));
  }
  getPermissionCodes(id: string) {
    return this.run((repo) => repo.getPermissionCodes(id));
  }
  getRoles(id: string) {
    return this.run((repo) => repo.getRoles(id));
  }
}
