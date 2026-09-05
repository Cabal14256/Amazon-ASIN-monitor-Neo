import type { Pool, PoolClient } from 'pg';
import { createDb, type Db } from '../client';
import { AuthRepository, type AuthDataRepository } from './auth-repository';

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
  operation: (db: Db) => Promise<T>,
): Promise<T> {
  // 获取连接由应用池的 connectionTimeoutMillis 约束。
  const client: PoolClient = await pool.connect();
  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let connectionError!: (error: Error) => void;
  const connectionFailure = new Promise<never>((_resolve, reject) => {
    connectionError = reject;
  });
  client.on('error', connectionError);
  const destroy = () => {
    if (!destroyed) {
      destroyed = true;
      client.release(true);
    }
  };
  const ensureOpen = () => {
    if (destroyed) throw new AuthQueryTimeoutError();
  };
  try {
    return await Promise.race([
      connectionFailure,
      (async () => {
        await client.query('BEGIN');
        ensureOpen();
        await client.query('SET LOCAL statement_timeout = 1500');
        ensureOpen();
        const result = await operation(createDb(client));
        ensureOpen();
        await client.query('COMMIT');
        return result;
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
    if (!destroyed) client.release();
  }
}

/** API 鉴权专用包装，复用主池但每个操作占用独立、有截止时间的事务。 */
export class BoundedAuthRepository implements AuthDataRepository {
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
