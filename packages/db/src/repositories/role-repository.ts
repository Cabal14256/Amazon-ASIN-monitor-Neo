import { and, asc, eq, getTableColumns, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { Db } from '../client';
import {
  permissions,
  rolePermissions,
  roles,
  sessions,
  userRoles,
  users,
} from '../schema';
import { AuthRepository, type AuthSessionRecord } from './auth-repository';
import { withAuthDatabaseDeadline } from './bounded-auth-repository';

export type RoleRecord = typeof roles.$inferSelect;
export type PermissionRecord = typeof permissions.$inferSelect;
export interface RolePermissionRecord extends PermissionRecord {
  roleId: string;
}
export interface RoleOperatorRecord {
  id: string;
  status: string;
  lockedUntil: Date | null;
  forcePasswordChange: boolean | null;
  passwordExpiresAt: Date | null;
}
export interface RoleReadUnit {
  listRoles(): Promise<RoleRecord[]>;
  findRole(roleId: string): Promise<RoleRecord | undefined>;
  listPermissions(): Promise<PermissionRecord[]>;
  listRolePermissions(roleId?: string): Promise<RolePermissionRecord[]>;
}
export interface RoleWriteUnit extends RoleReadUnit {
  lockOperator(userId: string): Promise<RoleOperatorRecord | undefined>;
  lockSession(
    userId: string,
    sessionId: string,
  ): Promise<AuthSessionRecord | undefined>;
  operatorPermissionCodes(userId: string): Promise<string[]>;
  usersWithRole(roleId: string): Promise<string[]>;
  replacePermissions(roleId: string, permissionIds: string[]): Promise<void>;
}
export interface RoleRepositoryPort {
  read<T>(operation: (unit: RoleReadUnit) => Promise<T>): Promise<T>;
  transaction<T>(operation: (unit: RoleWriteUnit) => Promise<T>): Promise<T>;
}

/** All Neo role assignments/status/admin changes must take this lock before user/session locks. */
export async function lockRoleAdministration(db: Db) {
  await db.execute(sql`select pg_advisory_xact_lock(1095977294, 1380073795)`);
}

export class DrizzleRoleUnit implements RoleWriteUnit {
  constructor(
    protected readonly db: Db,
    protected readonly ensureOpen: () => void,
  ) {}
  listRoles() {
    this.ensureOpen();
    return this.db.select().from(roles).orderBy(asc(roles.code), asc(roles.id));
  }
  async findRole(roleId: string) {
    this.ensureOpen();
    const [role] = await this.db
      .select()
      .from(roles)
      .where(eq(roles.id, roleId));
    return role;
  }
  listPermissions() {
    this.ensureOpen();
    return this.db
      .select()
      .from(permissions)
      .orderBy(
        sql`${permissions.resource} ASC NULLS FIRST`,
        sql`${permissions.action} ASC NULLS FIRST`,
        asc(permissions.id),
      );
  }
  listRolePermissions(roleId?: string) {
    this.ensureOpen();
    return this.db
      .select({
        ...getTableColumns(permissions),
        roleId: rolePermissions.roleId,
      })
      .from(rolePermissions)
      .innerJoin(permissions, eq(rolePermissions.permissionId, permissions.id))
      .where(
        roleId === undefined ? undefined : eq(rolePermissions.roleId, roleId),
      )
      .orderBy(
        asc(rolePermissions.roleId),
        asc(permissions.code),
        asc(permissions.id),
      );
  }
  async lockOperator(userId: string) {
    this.ensureOpen();
    const [operator] = await this.db
      .select({
        id: users.id,
        status: users.status,
        lockedUntil: users.lockedUntil,
        forcePasswordChange: users.forcePasswordChange,
        passwordExpiresAt: users.passwordExpiresAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    return operator;
  }
  async lockSession(userId: string, sessionId: string) {
    this.ensureOpen();
    const [session] = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
      .for('update');
    return session;
  }
  operatorPermissionCodes(userId: string) {
    this.ensureOpen();
    return new AuthRepository(this.db).getPermissionCodes(userId);
  }
  async usersWithRole(roleId: string) {
    this.ensureOpen();
    const rows = await this.db
      .select({ userId: userRoles.userId })
      .from(userRoles)
      .where(eq(userRoles.roleId, roleId))
      .orderBy(asc(userRoles.userId));
    return rows.map((row) => row.userId);
  }
  async replacePermissions(roleId: string, permissionIds: string[]) {
    this.ensureOpen();
    await this.db
      .delete(rolePermissions)
      .where(eq(rolePermissions.roleId, roleId));
    if (permissionIds.length) {
      this.ensureOpen();
      await this.db
        .insert(rolePermissions)
        .values(
          permissionIds.map((permissionId) => ({ roleId, permissionId })),
        );
    }
  }
}

export class PgRoleRepository implements RoleRepositoryPort {
  constructor(private readonly pool: Pool) {}
  read<T>(operation: (unit: RoleReadUnit) => Promise<T>): Promise<T> {
    return withAuthDatabaseDeadline(this.pool, async (db, ensureOpen) => {
      ensureOpen();
      await db.execute(
        sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`,
      );
      return operation(new DrizzleRoleUnit(db, ensureOpen));
    });
  }
  transaction<T>(operation: (unit: RoleWriteUnit) => Promise<T>): Promise<T> {
    return withAuthDatabaseDeadline(this.pool, async (db, ensureOpen) => {
      ensureOpen();
      await lockRoleAdministration(db);
      ensureOpen();
      return operation(new DrizzleRoleUnit(db, ensureOpen));
    });
  }
}
