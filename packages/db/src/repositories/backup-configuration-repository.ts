import { asc, eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import {
  BackupConfigError,
  backupConfigInput,
  defaultBackupConfig,
  validateBackupConfigRow,
  type BackupConfigInput,
  type BackupConfigRow,
} from '../domain/backup-configuration';
import { backupConfig } from '../schema';
import { withAuthDatabaseDeadline } from './bounded-auth-repository';
import {
  DrizzleRoleUnit,
  lockRoleAdministration,
  type RoleWriteUnit,
} from './role-repository';

export interface BackupConfigUnit extends RoleWriteUnit {
  get(): Promise<BackupConfigRow>;
  upsert(input: unknown): Promise<BackupConfigRow>;
}

export interface BackupConfigRepositoryPort {
  transaction<T>(operation: (unit: BackupConfigUnit) => Promise<T>): Promise<T>;
}

class DrizzleBackupConfigUnit
  extends DrizzleRoleUnit
  implements BackupConfigUnit
{
  private async findPersisted(): Promise<BackupConfigRow | undefined> {
    this.ensureOpen();
    const rows = await this.db
      .select()
      .from(backupConfig)
      .orderBy(asc(backupConfig.id))
      .limit(2);
    this.ensureOpen();
    if (rows.length > 1) throw new BackupConfigError('result');
    return rows[0] ? validateBackupConfigRow(rows[0]) : undefined;
  }

  async get() {
    return (await this.findPersisted()) ?? defaultBackupConfig();
  }

  async upsert(raw: unknown) {
    const input = backupConfigInput(raw);
    const existing = await this.findPersisted();
    this.ensureOpen();
    // Keep timestamps in the database's Shanghai-local convention used by the
    // baseline trigger and every other configuration repository.
    const values = {
      enabled: input.enabled,
      scheduleType: input.scheduleType,
      scheduleValue: input.scheduleValue,
      backupTime: input.backupTime,
      updateTime: sql`CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai'`,
    };
    const [row] = existing?.id
      ? await this.db
          .update(backupConfig)
          .set(values)
          .where(eq(backupConfig.id, existing.id))
          .returning()
      : await this.db
          .insert(backupConfig)
          .values({
            ...values,
            createTime: sql`CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai'`,
          })
          .returning();
    this.ensureOpen();
    if (!row) throw new BackupConfigError('result');
    return validateBackupConfigRow(row);
  }
}

export class PgBackupConfigRepository implements BackupConfigRepositoryPort {
  private active = 0;
  constructor(private readonly pool: Pool) {}

  async transaction<T>(
    operation: (unit: BackupConfigUnit) => Promise<T>,
  ): Promise<T> {
    if (this.active >= 16) throw new BackupConfigError('capacity');
    this.active++;
    try {
      return await withAuthDatabaseDeadline(
        this.pool,
        async (db, ensureOpen) => {
          await lockRoleAdministration(db);
          ensureOpen();
          return operation(new DrizzleBackupConfigUnit(db, ensureOpen));
        },
      );
    } finally {
      this.active--;
    }
  }
}

export type { BackupConfigInput, BackupConfigRow };
