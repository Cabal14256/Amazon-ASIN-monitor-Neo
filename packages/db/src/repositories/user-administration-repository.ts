import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import {
  roles,
  sessions,
  userRoles,
  users,
  userStatusHistory,
} from '../schema';
import {
  AuthRepository,
  type AuthRoleRecord,
  type AuthUserRecord,
} from './auth-repository';
import { withAuthDatabaseDeadline } from './bounded-auth-repository';
import {
  DrizzleRoleUnit,
  lockRoleAdministration,
  type RoleWriteUnit,
} from './role-repository';

export interface NewManagedUser {
  id: string;
  username: string;
  passwordHash: string;
  realName: string | null;
  forcePasswordChange: boolean;
  passwordExpiresAt: Date;
  now: Date;
}
export interface UserAdministrationUnit extends RoleWriteUnit {
  lockUser(userId: string): Promise<AuthUserRecord | undefined>;
  findPublicUser(userId: string): Promise<AuthUserRecord | undefined>;
  usernameExists(username: string): Promise<boolean>;
  rolesByIds(roleIds: string[]): Promise<AuthRoleRecord[]>;
  rolesForUser(userId: string): Promise<AuthRoleRecord[]>;
  createUser(input: NewManagedUser): Promise<void>;
  replaceRoles(userId: string, roleIds: string[]): Promise<void>;
  updateName(userId: string, name: string, now: Date): Promise<void>;
  changeStatus(
    userId: string,
    oldStatus: string,
    newStatus: string,
    reason: string | null,
    operatorId: string,
    now: Date,
  ): Promise<void>;
  countActiveAdmins(excludeUserId?: string): Promise<number>;
  deleteUser(userId: string): Promise<void>;
  attemptUserOperation<T>(
    operation: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }>;
}
export interface UserAdministrationRepositoryPort {
  transaction<T>(
    operation: (unit: UserAdministrationUnit) => Promise<T>,
  ): Promise<T>;
}

class DrizzleUserAdministrationUnit
  extends DrizzleRoleUnit
  implements UserAdministrationUnit
{
  async lockUser(userId: string) {
    if (!(await this.lockOperator(userId))) return undefined;
    return this.findPublicUser(userId);
  }
  findPublicUser(userId: string) {
    this.ensureOpen();
    return new AuthRepository(this.db).findUserById(userId);
  }
  async usernameExists(username: string) {
    this.ensureOpen();
    const rows = await this.db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.username}) = lower(${username})`)
      .limit(1);
    return rows.length > 0;
  }
  rolesByIds(roleIds: string[]) {
    this.ensureOpen();
    return this.db
      .select({ id: roles.id, code: roles.code, name: roles.name })
      .from(roles)
      .where(inArray(roles.id, roleIds))
      .orderBy(roles.code, roles.id);
  }
  rolesForUser(userId: string) {
    this.ensureOpen();
    return new AuthRepository(this.db).getRoles(userId);
  }
  async createUser(input: NewManagedUser) {
    this.ensureOpen();
    await this.db.insert(users).values({
      id: input.id,
      username: input.username,
      password: input.passwordHash,
      realName: input.realName,
      status: 'ACTIVE',
      forcePasswordChange: input.forcePasswordChange,
      passwordExpiresAt: input.passwordExpiresAt,
      passwordChangedAt: input.now,
      createTime: input.now,
      updateTime: input.now,
    });
  }
  async replaceRoles(userId: string, roleIds: string[]) {
    this.ensureOpen();
    await this.db.delete(userRoles).where(eq(userRoles.userId, userId));
    if (roleIds.length) {
      this.ensureOpen();
      await this.db
        .insert(userRoles)
        .values(roleIds.map((roleId) => ({ userId, roleId })));
    }
  }
  async updateName(userId: string, name: string, now: Date) {
    this.ensureOpen();
    await this.db
      .update(users)
      .set({ realName: name, updateTime: now })
      .where(eq(users.id, userId));
  }
  async changeStatus(
    userId: string,
    oldStatus: string,
    newStatus: string,
    reason: string | null,
    operatorId: string,
    now: Date,
  ) {
    this.ensureOpen();
    await this.db
      .update(users)
      .set({
        status: newStatus,
        updateTime: now,
        ...(newStatus !== 'LOCKED' ? { lockedUntil: null } : {}),
        ...(newStatus === 'ACTIVE'
          ? { failedLoginAttempts: 0, lastFailedLogin: null }
          : {}),
      })
      .where(eq(users.id, userId));
    this.ensureOpen();
    await this.db.insert(userStatusHistory).values({
      userId,
      oldStatus,
      newStatus,
      reason,
      changedBy: operatorId,
      createdAt: now,
    });
    if (newStatus !== 'ACTIVE') {
      this.ensureOpen();
      await this.db
        .update(sessions)
        .set({ status: 'REVOKED', lastActiveAt: now })
        .where(eq(sessions.userId, userId));
    }
  }
  async countActiveAdmins(excludeUserId?: string) {
    this.ensureOpen();
    const [row] = await this.db
      .select({ count: sql<string>`count(distinct ${users.id})` })
      .from(users)
      .innerJoin(userRoles, eq(userRoles.userId, users.id))
      .innerJoin(roles, eq(roles.id, userRoles.roleId))
      .where(
        and(
          eq(roles.code, 'ADMIN'),
          eq(users.status, 'ACTIVE'),
          excludeUserId ? ne(users.id, excludeUserId) : undefined,
        ),
      );
    const count = Number(row.count);
    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error('Invalid administrator count');
    return count;
  }
  async deleteUser(userId: string) {
    this.ensureOpen();
    await this.db.delete(users).where(eq(users.id, userId));
  }
  async attemptUserOperation<T>(
    operation: () => Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    this.ensureOpen();
    await this.db.execute(sql`SAVEPOINT user_administration_delete`);
    let value: T;
    try {
      value = await operation();
    } catch {
      // Continue only if PostgreSQL actually recovered this transaction. A
      // connection/deadline failure propagates and rolls the entire batch back.
      this.ensureOpen();
      await this.db.execute(
        sql`ROLLBACK TO SAVEPOINT user_administration_delete`,
      );
      this.ensureOpen();
      await this.db.execute(sql`RELEASE SAVEPOINT user_administration_delete`);
      return { ok: false };
    }
    this.ensureOpen();
    await this.db.execute(sql`RELEASE SAVEPOINT user_administration_delete`);
    return { ok: true, value };
  }
}

export class PgUserAdministrationRepository
  implements UserAdministrationRepositoryPort
{
  constructor(private readonly pool: Pool) {}
  transaction<T>(
    operation: (unit: UserAdministrationUnit) => Promise<T>,
  ): Promise<T> {
    return withAuthDatabaseDeadline(this.pool, async (db, ensureOpen) => {
      ensureOpen();
      await lockRoleAdministration(db);
      ensureOpen();
      return operation(new DrizzleUserAdministrationUnit(db, ensureOpen));
    });
  }
}
