import { and, asc, desc, eq, ilike, inArray, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { roles, userRoles, users, userStatusHistory } from '../schema';
import {
  AuthRepository,
  type AuthRoleRecord,
  type AuthUserRecord,
} from './auth-repository';
import { withAuthDatabaseDeadline } from './bounded-auth-repository';

export interface UserQuery {
  username?: string;
  status?: string;
  current: number;
  pageSize: number;
}
export interface UserQueryRole extends AuthRoleRecord {
  userId: string;
}
export interface UserQueryList {
  users: AuthUserRecord[];
  total: number;
  roles: UserQueryRole[];
}
export interface UserQueryDetail {
  user: AuthUserRecord;
  roles: AuthRoleRecord[];
  permissions: string[];
  statusHistory: (typeof userStatusHistory.$inferSelect)[];
}
export interface UserQueryRepositoryPort {
  list(query: UserQuery): Promise<UserQueryList>;
  detail(userId: string): Promise<UserQueryDetail | undefined>;
}

// Explicit public column allowlist: never select password or login failure payloads.
const publicColumns = {
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
};

export class PgUserQueryRepository implements UserQueryRepositoryPort {
  constructor(private readonly pool: Pool) {}
  private read<T>(
    operation: Parameters<typeof withAuthDatabaseDeadline<T>>[1],
  ) {
    return withAuthDatabaseDeadline(this.pool, async (db, ensureOpen) => {
      ensureOpen();
      await db.execute(
        sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`,
      );
      return operation(db, ensureOpen);
    });
  }
  list(query: UserQuery): Promise<UserQueryList> {
    return this.read(async (db, ensureOpen) => {
      const where = and(
        query.username
          ? ilike(users.username, `%${query.username}%`)
          : undefined,
        query.status ? eq(users.status, query.status) : undefined,
      );
      const [count] = await db
        .select({ total: sql<string>`count(*)` })
        .from(users)
        .where(where);
      const total = Number(count.total);
      if (!Number.isSafeInteger(total) || total < 0)
        throw new Error('Invalid user count');
      ensureOpen();
      const page = await db
        .select(publicColumns)
        .from(users)
        .where(where)
        .orderBy(sql`${users.createTime} DESC NULLS LAST`, desc(users.id))
        .limit(query.pageSize)
        .offset((query.current - 1) * query.pageSize);
      if (!page.length) return { users: [], total, roles: [] };
      ensureOpen();
      const assigned = await db
        .select({
          userId: userRoles.userId,
          id: roles.id,
          code: roles.code,
          name: roles.name,
        })
        .from(userRoles)
        .innerJoin(roles, eq(userRoles.roleId, roles.id))
        .where(
          inArray(
            userRoles.userId,
            page.map((user) => user.id),
          ),
        )
        .orderBy(asc(roles.code), asc(roles.id));
      return { users: page, total, roles: assigned };
    });
  }
  detail(userId: string): Promise<UserQueryDetail | undefined> {
    return this.read(async (db, ensureOpen) => {
      const auth = new AuthRepository(db);
      const user = await auth.findUserById(userId);
      if (!user) return undefined;
      ensureOpen();
      const assigned = await auth.getRoles(userId);
      ensureOpen();
      const permissions = await auth.getPermissionCodes(userId);
      ensureOpen();
      const history = await db
        .select()
        .from(userStatusHistory)
        .where(eq(userStatusHistory.userId, userId))
        .orderBy(
          sql`${userStatusHistory.createdAt} DESC NULLS LAST`,
          desc(userStatusHistory.id),
        )
        .limit(10);
      return { user, roles: assigned, permissions, statusHistory: history };
    });
  }
}
