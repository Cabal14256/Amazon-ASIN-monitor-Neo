import { eq } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { Db } from '../client';
import { sessions } from '../schema';
import { DrizzleAccountUnit, type AccountUnit } from './account-repository';
import { withAuthDatabaseDeadline } from './bounded-auth-repository';
import {
  DrizzleRoleUnit,
  lockRoleAdministration,
  type RoleWriteUnit,
} from './role-repository';

export interface UserPasswordUnit extends RoleWriteUnit {
  readonly credentials: Pick<
    AccountUnit,
    'lockUser' | 'recentPasswords' | 'savePreviousPassword' | 'updatePassword'
  >;
  revokeAllSessions(userId: string, now: Date): Promise<void>;
}
export interface UserPasswordRepositoryPort {
  transaction<T>(operation: (unit: UserPasswordUnit) => Promise<T>): Promise<T>;
}

class DrizzleUserPasswordUnit
  extends DrizzleRoleUnit
  implements UserPasswordUnit
{
  readonly credentials: UserPasswordUnit['credentials'];
  constructor(db: Db, ensureOpen: () => void) {
    super(db, ensureOpen);
    this.credentials = new DrizzleAccountUnit(db, ensureOpen);
  }
  async revokeAllSessions(userId: string, now: Date) {
    this.ensureOpen();
    await this.db
      .update(sessions)
      .set({ status: 'REVOKED', lastActiveAt: now })
      .where(eq(sessions.userId, userId));
  }
}

export class PgUserPasswordRepository implements UserPasswordRepositoryPort {
  constructor(private readonly pool: Pool) {}
  transaction<T>(
    operation: (unit: UserPasswordUnit) => Promise<T>,
  ): Promise<T> {
    return withAuthDatabaseDeadline(this.pool, async (db, ensureOpen) => {
      ensureOpen();
      await lockRoleAdministration(db);
      ensureOpen();
      return operation(new DrizzleUserPasswordUnit(db, ensureOpen));
    });
  }
}
