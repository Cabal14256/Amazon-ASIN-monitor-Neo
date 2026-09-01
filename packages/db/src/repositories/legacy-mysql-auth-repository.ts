import mysql, { type Pool, type RowDataPacket } from 'mysql2/promise';

import { parseShanghaiTimestamp } from '../client';
import type {
  AuthDataRepository,
  AuthRoleRecord,
  AuthSessionRecord,
  AuthUserRecord,
} from './auth-repository';

export interface LegacyMysqlAuthRepositoryConfig {
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

interface LegacyUserRow extends RowDataPacket {
  id: string;
  username: string;
  real_name: string | null;
  status: string;
  last_login_time: string | null;
  last_login_ip: string | null;
  password_expires_at: string | null;
  password_changed_at: string | null;
  force_password_change: boolean | number | null;
  failed_login_attempts: number | null;
  locked_until: string | null;
  create_time: string | null;
  update_time: string | null;
}

interface LegacyPermissionRow extends RowDataPacket {
  code: string;
}

interface LegacyRoleRow extends RowDataPacket {
  id: string;
  code: string;
  name: string;
}

function optionalTimestamp(value: string | null): Date | null {
  return value === null ? null : parseShanghaiTimestamp(value);
}

/** 双跑期直接读取 Legacy MySQL 的实时用户、Session 与 RBAC 权威状态。 */
export class LegacyMysqlAuthRepository implements AuthDataRepository {
  private readonly pool: Pool;
  private closed = false;

  constructor(
    private readonly config: LegacyMysqlAuthRepositoryConfig,
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

  private async rows<T extends RowDataPacket>(
    sql: string,
    values: readonly unknown[],
  ): Promise<T[]> {
    const [rows] = await this.pool.query<T[]>({
      sql,
      values,
      timeout: this.config.queryTimeoutMs,
    });
    return rows;
  }

  private async update(sql: string, values: readonly unknown[]): Promise<void> {
    await this.pool.query({
      sql,
      values,
      timeout: this.config.queryTimeoutMs,
    });
  }

  async findSessionById(
    sessionId: string,
  ): Promise<AuthSessionRecord | undefined> {
    const [row] = await this.rows<LegacySessionRow>(
      `SELECT id, user_id, user_agent, ip_address, status, remember_me,
              created_at, last_active_at, expires_at
         FROM sessions
        WHERE id = ?
        LIMIT 1`,
      [sessionId],
    );
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
      expiresAt: optionalTimestamp(row.expires_at),
    };
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.update(
      `UPDATE sessions
          SET status = 'REVOKED',
              last_active_at = UTC_TIMESTAMP() + INTERVAL 8 HOUR
        WHERE id = ?`,
      [sessionId],
    );
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.update(
      `UPDATE sessions
          SET last_active_at = UTC_TIMESTAMP() + INTERVAL 8 HOUR
        WHERE id = ?`,
      [sessionId],
    );
  }

  async findUserById(userId: string): Promise<AuthUserRecord | undefined> {
    const [row] = await this.rows<LegacyUserRow>(
      `SELECT id, username, real_name, status, last_login_time, last_login_ip,
              password_expires_at, password_changed_at, force_password_change,
              failed_login_attempts, locked_until, create_time, update_time
         FROM users
        WHERE id = ?
        LIMIT 1`,
      [userId],
    );
    if (!row) return undefined;
    return {
      id: row.id,
      username: row.username,
      realName: row.real_name,
      status: row.status,
      lastLoginTime: optionalTimestamp(row.last_login_time),
      lastLoginIp: row.last_login_ip,
      passwordExpiresAt: optionalTimestamp(row.password_expires_at),
      passwordChangedAt: optionalTimestamp(row.password_changed_at),
      forcePasswordChange:
        row.force_password_change === null
          ? null
          : Boolean(row.force_password_change),
      failedLoginAttempts: row.failed_login_attempts,
      lockedUntil: optionalTimestamp(row.locked_until),
      createTime: optionalTimestamp(row.create_time),
      updateTime: optionalTimestamp(row.update_time),
    };
  }

  async markPasswordChangeRequired(userId: string): Promise<void> {
    await this.update(
      'UPDATE users SET force_password_change = 1 WHERE id = ?',
      [userId],
    );
  }

  async getPermissionCodes(userId: string): Promise<string[]> {
    const rows = await this.rows<LegacyPermissionRow>(
      `SELECT DISTINCT p.code
         FROM user_roles ur
         JOIN role_permissions rp ON ur.role_id = rp.role_id
         JOIN permissions p ON rp.permission_id = p.id
        WHERE ur.user_id = ?
        ORDER BY p.code`,
      [userId],
    );
    return rows.map(({ code }) => code);
  }

  async getRoles(userId: string): Promise<AuthRoleRecord[]> {
    return this.rows<LegacyRoleRow>(
      `SELECT DISTINCT r.id, r.code, r.name
         FROM user_roles ur
         JOIN roles r ON ur.role_id = r.id
        WHERE ur.user_id = ?
        ORDER BY r.code`,
      [userId],
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.end();
  }
}
