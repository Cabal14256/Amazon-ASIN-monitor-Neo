import { eq, sql } from 'drizzle-orm';

import type { Db } from '../client';
import {
  permissions,
  rolePermissions,
  roles,
  sessions,
  userRoles,
  users,
} from '../schema';

export type AuthSessionRecord = typeof sessions.$inferSelect;

export interface AuthUserRecord {
  id: string;
  username: string;
  realName: string | null;
  status: string;
  lastLoginTime: Date | null;
  lastLoginIp: string | null;
  passwordExpiresAt: Date | null;
  passwordChangedAt: Date | null;
  forcePasswordChange: boolean | null;
  failedLoginAttempts: number | null;
  lockedUntil: Date | null;
  createTime: Date | null;
  updateTime: Date | null;
}

export interface AuthRoleRecord {
  id: string;
  code: string;
  name: string;
}

export interface AuthSessionRepository {
  findSessionById(sessionId: string): Promise<AuthSessionRecord | undefined>;
  revokeSession(sessionId: string): Promise<void>;
  touchSession(sessionId: string): Promise<void>;
}

export interface AuthDataRepository extends AuthSessionRepository {
  findUserById(userId: string): Promise<AuthUserRecord | undefined>;
  markPasswordChangeRequired(userId: string): Promise<void>;
  getPermissionCodes(userId: string): Promise<string[]>;
  getRoles(userId: string): Promise<AuthRoleRecord[]>;
}

/** 鉴权域的 Drizzle 数据访问层，不持有连接池生命周期。 */
export class AuthRepository implements AuthDataRepository {
  constructor(private readonly db: Db) {}

  async findSessionById(
    sessionId: string,
  ): Promise<AuthSessionRecord | undefined> {
    const [session] = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    return session;
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ status: 'REVOKED', lastActiveAt: sql`LOCALTIMESTAMP` })
      .where(eq(sessions.id, sessionId));
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.db
      .update(sessions)
      .set({ lastActiveAt: sql`LOCALTIMESTAMP` })
      .where(eq(sessions.id, sessionId));
  }

  async findUserById(userId: string): Promise<AuthUserRecord | undefined> {
    const [user] = await this.db
      .select({
        id: users.id,
        username: users.username,
        realName: users.realName,
        status: users.status,
        lastLoginTime: users.lastLoginTime,
        lastLoginIp: users.lastLoginIp,
        passwordExpiresAt: users.passwordExpiresAt,
        passwordChangedAt: users.passwordChangedAt,
        forcePasswordChange: users.forcePasswordChange,
        failedLoginAttempts: users.failedLoginAttempts,
        lockedUntil: users.lockedUntil,
        createTime: users.createTime,
        updateTime: users.updateTime,
      })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return user;
  }

  async markPasswordChangeRequired(userId: string): Promise<void> {
    await this.db
      .update(users)
      .set({ forcePasswordChange: true })
      .where(eq(users.id, userId));
  }

  async getPermissionCodes(userId: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ code: permissions.code })
      .from(userRoles)
      .innerJoin(rolePermissions, eq(userRoles.roleId, rolePermissions.roleId))
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(eq(userRoles.userId, userId))
      .orderBy(permissions.code);
    return rows.map(({ code }) => code);
  }

  async getRoles(userId: string): Promise<AuthRoleRecord[]> {
    return this.db
      .selectDistinct({ id: roles.id, code: roles.code, name: roles.name })
      .from(userRoles)
      .innerJoin(roles, eq(userRoles.roleId, roles.id))
      .where(eq(userRoles.userId, userId))
      .orderBy(roles.code);
  }
}
