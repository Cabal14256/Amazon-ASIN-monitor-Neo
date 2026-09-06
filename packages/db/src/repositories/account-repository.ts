import { and, desc, eq, ne, notInArray, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { Db } from '../client';
import { passwordHistory, sessions, users } from '../schema';
import {
  AuthRepository,
  type AuthRoleRecord,
  type AuthSessionRecord,
} from './auth-repository';
import { withAuthDatabaseDeadline } from './bounded-auth-repository';

export type AccountUserRecord = typeof users.$inferSelect;
export interface AccountUnit {
  lockUser(userId: string): Promise<AccountUserRecord | undefined>;
  lockSession(
    userId: string,
    sessionId: string,
  ): Promise<AuthSessionRecord | undefined>;
  recentPasswords(userId: string): Promise<string[]>;
  savePreviousPassword(userId: string, hash: string, now: Date): Promise<void>;
  updatePassword(
    userId: string,
    hash: string,
    now: Date,
    expiresAt: Date,
  ): Promise<void>;
  revokeOtherSessions(
    userId: string,
    currentSessionId: string,
    now: Date,
  ): Promise<void>;
  updateProfile(
    userId: string,
    realName: string,
    now: Date,
  ): Promise<AccountUserRecord>;
  access(
    userId: string,
  ): Promise<{ permissions: string[]; roles: AuthRoleRecord[] }>;
}
export interface AccountRepositoryPort {
  transaction<T>(operation: (unit: AccountUnit) => Promise<T>): Promise<T>;
}

class DrizzleAccountUnit implements AccountUnit {
  constructor(
    private readonly db: Db,
    private readonly ensureOpen: () => void,
  ) {}
  async lockUser(userId: string) {
    this.ensureOpen();
    const [user] = await this.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    return user;
  }
  async lockSession(userId: string, sessionId: string) {
    this.ensureOpen();
    const [session] = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.userId, userId), eq(sessions.id, sessionId)))
      .for('update');
    return session;
  }
  private recent(userId: string) {
    this.ensureOpen();
    return this.db
      .select({ id: passwordHistory.id, hash: passwordHistory.passwordHash })
      .from(passwordHistory)
      .where(eq(passwordHistory.userId, userId))
      .orderBy(
        sql`${passwordHistory.createdAt} DESC NULLS LAST`,
        desc(passwordHistory.id),
      )
      .limit(5);
  }
  async recentPasswords(userId: string) {
    return (await this.recent(userId)).map((row) => row.hash);
  }
  async savePreviousPassword(userId: string, hash: string, now: Date) {
    this.ensureOpen();
    await this.db
      .insert(passwordHistory)
      .values({ userId, passwordHash: hash, createdAt: now });
    const retained = await this.recent(userId);
    this.ensureOpen();
    await this.db.delete(passwordHistory).where(
      and(
        eq(passwordHistory.userId, userId),
        notInArray(
          passwordHistory.id,
          retained.map((row) => row.id),
        ),
      ),
    );
  }
  async updatePassword(
    userId: string,
    hash: string,
    now: Date,
    expiresAt: Date,
  ) {
    this.ensureOpen();
    await this.db
      .update(users)
      .set({
        password: hash,
        passwordChangedAt: now,
        passwordExpiresAt: expiresAt,
        forcePasswordChange: false,
      })
      .where(eq(users.id, userId));
  }
  async revokeOtherSessions(
    userId: string,
    currentSessionId: string,
    now: Date,
  ) {
    this.ensureOpen();
    await this.db
      .update(sessions)
      .set({ status: 'REVOKED', lastActiveAt: now })
      .where(
        and(eq(sessions.userId, userId), ne(sessions.id, currentSessionId)),
      );
  }
  async updateProfile(userId: string, realName: string, now: Date) {
    this.ensureOpen();
    const [user] = await this.db
      .update(users)
      .set({ realName, updateTime: now })
      .where(eq(users.id, userId))
      .returning();
    if (!user) throw new Error('Account no longer exists');
    return user;
  }
  async access(userId: string) {
    const auth = new AuthRepository(this.db);
    this.ensureOpen();
    const permissions = await auth.getPermissionCodes(userId);
    this.ensureOpen();
    const roles = await auth.getRoles(userId);
    return { permissions, roles };
  }
}

/** All writes share the user row lock and the exclusive transaction deadline. */
export class PgAccountRepository implements AccountRepositoryPort {
  constructor(private readonly pool: Pool) {}
  transaction<T>(operation: (unit: AccountUnit) => Promise<T>): Promise<T> {
    return withAuthDatabaseDeadline(this.pool, (db, ensureOpen) =>
      operation(new DrizzleAccountUnit(db, ensureOpen)),
    );
  }
}
