import { asc, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import { spApiConfig } from '../schema';
import { withAuthDatabaseDeadline } from './bounded-auth-repository';
import {
  DrizzleRoleUnit,
  lockRoleAdministration,
  type RoleWriteUnit,
} from './role-repository';

export type SpApiConfigurationRow = typeof spApiConfig.$inferSelect;
export interface SpApiConfigurationChange {
  configKey: string;
  configValue: string;
  description: string;
}
export interface SpApiConfigurationUnit extends RoleWriteUnit {
  listConfiguration(): Promise<SpApiConfigurationRow[]>;
  findConfiguration(key: string): Promise<SpApiConfigurationRow | undefined>;
  upsertConfiguration(
    changes: readonly SpApiConfigurationChange[],
  ): Promise<SpApiConfigurationRow[]>;
}
export interface SpApiConfigurationRepositoryPort {
  transaction<T>(
    operation: (unit: SpApiConfigurationUnit) => Promise<T>,
  ): Promise<T>;
  readConfiguration(signal?: AbortSignal): Promise<SpApiConfigurationRow[]>;
}
export class SpApiConfigurationRepositoryError extends Error {
  constructor(
    readonly reason:
      | 'capacity'
      | 'invalid-input'
      | 'invalid-result'
      | 'cancelled',
  ) {
    super(`SP-API configuration ${reason}`);
  }
}
const columns = {
  id: spApiConfig.id,
  configKey: spApiConfig.configKey,
  // Bound bytes pulled into the process even if an out-of-band writer stored
  // an oversized TEXT value. The extra character makes truncation detectable.
  configValue: sql<string | null>`left(${spApiConfig.configValue}, 4097)`,
  description: spApiConfig.description,
  createTime: spApiConfig.createTime,
  updateTime: spApiConfig.updateTime,
};
function validateRows(rows: SpApiConfigurationRow[]) {
  if (
    rows.length > 200 ||
    rows.some(
      (row) =>
        !Number.isSafeInteger(row.id) ||
        row.id < 1 ||
        (row.configValue !== null && row.configValue.length > 4096),
    )
  )
    throw new SpApiConfigurationRepositoryError('invalid-result');
  return rows;
}
class DrizzleSpApiConfigurationUnit
  extends DrizzleRoleUnit
  implements SpApiConfigurationUnit
{
  async listConfiguration() {
    this.ensureOpen();
    return validateRows(
      await this.db
        .select(columns)
        .from(spApiConfig)
        .orderBy(asc(sql`lower(${spApiConfig.configKey})`))
        .limit(201),
    );
  }
  async findConfiguration(key: string) {
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_]{1,50}$/.test(key))
      throw new SpApiConfigurationRepositoryError('invalid-input');
    this.ensureOpen();
    const rows = await this.db
      .select(columns)
      .from(spApiConfig)
      .where(sql`lower(${spApiConfig.configKey}) = ${key.toLowerCase()}`)
      .limit(2);
    if (rows.length > 1)
      throw new SpApiConfigurationRepositoryError('invalid-result');
    return validateRows(rows)[0];
  }
  async upsertConfiguration(changes: readonly SpApiConfigurationChange[]) {
    if (
      !Array.isArray(changes) ||
      changes.length < 1 ||
      changes.length > 26 ||
      changes.some(
        (change) =>
          !change ||
          typeof change.configKey !== 'string' ||
          !/^[A-Z0-9_]{1,50}$/.test(change.configKey) ||
          typeof change.configValue !== 'string' ||
          change.configValue.length > 4096 ||
          typeof change.description !== 'string' ||
          change.description.length > 255,
      ) ||
      new Set(changes.map((change) => change.configKey)).size !==
        changes.length ||
      changes.reduce(
        (size, change) =>
          size +
          Buffer.byteLength(
            change.configKey + change.configValue + change.description,
          ),
        0,
      ) > 65_536
    )
      throw new SpApiConfigurationRepositoryError('invalid-input');
    this.ensureOpen();
    const values = sql.join(
      changes.map(
        (change) =>
          sql`(${change.configKey}, ${change.configValue}, ${change.description})`,
      ),
      sql`, `,
    );
    // Target the baseline expression index to update existing lowercase Legacy
    // keys without colliding with its case-insensitive uniqueness constraint.
    await this.db
      .execute(sql`INSERT INTO ${spApiConfig} (config_key, config_value, description) VALUES ${values}
      ON CONFLICT (lower(config_key)) DO UPDATE SET
        config_key = EXCLUDED.config_key, config_value = EXCLUDED.config_value,
        description = EXCLUDED.description, update_time = CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai'`);
    this.ensureOpen();
    const keys = changes.map((change) => sql`${change.configKey}`);
    const rows = validateRows(
      await this.db
        .select(columns)
        .from(spApiConfig)
        .where(sql`${spApiConfig.configKey} IN (${sql.join(keys, sql`, `)})`)
        .limit(27),
    );
    const byKey = new Map(rows.map((row) => [row.configKey, row]));
    return changes.map((change) => {
      const row = byKey.get(change.configKey);
      if (!row) throw new SpApiConfigurationRepositoryError('invalid-result');
      return row;
    });
  }
}

export class PgSpApiConfigurationRepository
  implements SpApiConfigurationRepositoryPort
{
  private active = 0;
  constructor(private readonly pool: Pool) {}
  private async run<T>(operation: () => Promise<T>) {
    if (this.active >= 16)
      throw new SpApiConfigurationRepositoryError('capacity');
    this.active++;
    try {
      return await operation();
    } finally {
      this.active--;
    }
  }
  transaction<T>(
    operation: (unit: SpApiConfigurationUnit) => Promise<T>,
  ): Promise<T> {
    return this.run(() =>
      withAuthDatabaseDeadline(this.pool, async (db, ensureOpen) => {
        ensureOpen();
        await lockRoleAdministration(db);
        ensureOpen();
        return operation(new DrizzleSpApiConfigurationUnit(db, ensureOpen));
      }),
    );
  }
  readConfiguration(signal?: AbortSignal) {
    const ensureActive = () => {
      if (signal?.aborted)
        throw new SpApiConfigurationRepositoryError('cancelled');
    };
    return this.run(async () => {
      ensureActive();
      return withAuthDatabaseDeadline(this.pool, async (db, ensureOpen) => {
        ensureActive();
        const rows = await new DrizzleSpApiConfigurationUnit(
          db,
          ensureOpen,
        ).listConfiguration();
        ensureActive();
        return rows;
      });
    });
  }
}
