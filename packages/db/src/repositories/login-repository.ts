import { eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { Db } from '../client';
import { loginAttempts, sessions, users } from '../schema';
import { AuthRepository, type AuthRoleRecord } from './auth-repository';
import { withAuthDatabaseDeadline } from './bounded-auth-repository';

export type LoginUserRecord = typeof users.$inferSelect;
export type LoginUserPatch = Partial<
  Pick<
    LoginUserRecord,
    | 'status'
    | 'lockedUntil'
    | 'failedLoginAttempts'
    | 'lastFailedLogin'
    | 'lastLoginTime'
    | 'lastLoginIp'
    | 'forcePasswordChange'
  >
>;
export interface LoginUnit {
  lockUser(username: string): Promise<LoginUserRecord | undefined>;
  updateUser(userId: string, patch: LoginUserPatch): Promise<void>;
  recordAttempt(username: string, ip: string, success: boolean): Promise<void>;
  createSession(session: typeof sessions.$inferInsert): Promise<void>;
  access(
    userId: string,
  ): Promise<{ permissions: string[]; roles: AuthRoleRecord[] }>;
}
export interface LoginRepositoryPort {
  transaction<T>(operation: (unit: LoginUnit) => Promise<T>): Promise<T>;
}

class DrizzleLoginUnit implements LoginUnit {
  constructor(private readonly db: Db) {}
  async lockUser(username: string) {
    const [user] = await this.db
      .select()
      .from(users)
      .where(sql`lower(${users.username}) = lower(${username})`)
      .limit(1)
      .for('update');
    return user;
  }
  async updateUser(userId: string, patch: LoginUserPatch) {
    await this.db.update(users).set(patch).where(eq(users.id, userId));
  }
  async recordAttempt(username: string, ip: string, success: boolean) {
    await this.db
      .insert(loginAttempts)
      .values({ username, ipAddress: ip, success });
  }
  async createSession(session: typeof sessions.$inferInsert) {
    await this.db.insert(sessions).values(session);
  }
  async access(userId: string) {
    const auth = new AuthRepository(this.db);
    const permissions = await auth.getPermissionCodes(userId);
    const roles = await auth.getRoles(userId);
    return { permissions, roles };
  }
}

/** Failure outcomes return normally so failed-attempt/lockout changes commit. */
export class PgLoginRepository implements LoginRepositoryPort {
  constructor(private readonly pool: Pool) {}
  transaction<T>(operation: (unit: LoginUnit) => Promise<T>): Promise<T> {
    return withAuthDatabaseDeadline(this.pool, (db) =>
      operation(new DrizzleLoginUnit(db)),
    );
  }
}
