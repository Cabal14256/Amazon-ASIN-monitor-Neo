import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';

import { parseShanghaiTimestamp } from '../client';
import type {
  AuthSessionRecord,
  AuthSessionRepository,
} from './auth-repository';

export interface LegacyMysqlSessionRepositoryConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit: number;
  connectTimeoutMs: number;
  queryTimeoutMs: number;
}

interface LegacySessionRow extends RowDataPacket {
  id: string;
  user_id: string;
  user_agent: string | null;
  ip_address: string | null;
  status: string;
  remember_me: boolean | number;
  created_at: string;
  last_active_at: string;
  expires_at: string | null;
}

/** 双跑期直接读取 Legacy MySQL 的实时 Session 权威状态。 */
export class LegacyMysqlSessionRepository implements AuthSessionRepository {
  private readonly pool: Pool;
  private closed = false;

  constructor(
    private readonly config: LegacyMysqlSessionRepositoryConfig,
    pool?: Pool,
  ) {
    this.pool =
      pool ??
      mysql.createPool({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        charset: 'utf8mb4',
        timezone: '+08:00',
        dateStrings: true,
        waitForConnections: true,
        connectionLimit: config.connectionLimit,
        queueLimit: 200,
        connectTimeout: config.connectTimeoutMs,
      });
  }

  async findSessionById(
    sessionId: string,
  ): Promise<AuthSessionRecord | undefined> {
    const [rows] = await this.pool.query<LegacySessionRow[]>({
      sql: `SELECT id, user_id, user_agent, ip_address, status, remember_me,
                   created_at, last_active_at, expires_at
              FROM sessions
             WHERE id = ?
             LIMIT 1`,
      values: [sessionId],
      timeout: this.config.queryTimeoutMs,
    });
    const row = rows[0];
    if (!row) return undefined;
    return {
      id: row.id,
      userId: row.user_id,
      userAgent: row.user_agent,
      ipAddress: row.ip_address,
      status: row.status,
      rememberMe: Boolean(row.remember_me),
      createdAt: parseShanghaiTimestamp(row.created_at),
      lastActiveAt: parseShanghaiTimestamp(row.last_active_at),
      expiresAt:
        row.expires_at === null ? null : parseShanghaiTimestamp(row.expires_at),
    };
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.pool.query({
      sql: `UPDATE sessions
               SET status = 'REVOKED', last_active_at = NOW()
             WHERE id = ?`,
      values: [sessionId],
      timeout: this.config.queryTimeoutMs,
    });
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.pool.query({
      sql: 'UPDATE sessions SET last_active_at = NOW() WHERE id = ?',
      values: [sessionId],
      timeout: this.config.queryTimeoutMs,
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}
