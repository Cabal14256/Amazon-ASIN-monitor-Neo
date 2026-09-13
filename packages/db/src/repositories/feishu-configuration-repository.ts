import { asc, eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import {
  feishuConfigurationChange,
  FeishuConfigurationError,
  feishuCountry,
  feishuRegion,
  validateFeishuRow,
  type FeishuConfigurationChange,
  type FeishuConfigurationRow,
} from '../domain/feishu-configuration';
import { feishuConfig } from '../schema';
import { withAuthDatabaseDeadline } from './bounded-auth-repository';
import {
  DrizzleRoleUnit,
  lockRoleAdministration,
  type RoleWriteUnit,
} from './role-repository';

export interface FeishuConfigurationUnit
  extends Pick<
    RoleWriteUnit,
    'lockOperator' | 'lockSession' | 'operatorPermissionCodes'
  > {
  list(): Promise<FeishuConfigurationRow[]>;
  find(country: string): Promise<FeishuConfigurationRow | undefined>;
  upsert(change: FeishuConfigurationChange): Promise<FeishuConfigurationRow>;
  delete(country: string): Promise<void>;
  toggle(
    country: string,
    enabled: boolean,
  ): Promise<FeishuConfigurationRow | undefined>;
}
export interface FeishuConfigurationRepositoryPort {
  transaction<T>(
    action: (unit: FeishuConfigurationUnit) => Promise<T>,
  ): Promise<T>;
}
const matches = (country: string) =>
  sql`rtrim(${feishuConfig.country}) COLLATE public.neo_import_group_ci = rtrim(${country})`;
class DrizzleFeishuConfigurationUnit
  extends DrizzleRoleUnit
  implements FeishuConfigurationUnit
{
  private async exact(country: string) {
    feishuCountry(country);
    this.ensureOpen();
    const rows = await this.db
      .select()
      .from(feishuConfig)
      .where(matches(country))
      .limit(2);
    this.ensureOpen();
    if (rows.length > 1) throw new FeishuConfigurationError('result');
    return rows[0] && validateFeishuRow(rows[0]);
  }
  async list() {
    this.ensureOpen();
    const rows = await this.db
      .select()
      .from(feishuConfig)
      .where(
        sql`rtrim(${feishuConfig.country}) COLLATE public.neo_import_group_ci IN ('US','EU')`,
      )
      .orderBy(
        asc(sql`${feishuConfig.country} COLLATE public.neo_import_group_ci`),
        asc(feishuConfig.id),
      )
      .limit(3);
    this.ensureOpen();
    // Legacy's UNIQUE country cannot contain multiple equivalent US/EU rows.
    if (rows.length > 2) throw new FeishuConfigurationError('result');
    for (const row of rows) {
      validateFeishuRow(row);
      await this.exact(row.country);
    }
    return rows;
  }
  async find(country: string) {
    const row = await this.exact(feishuRegion(feishuCountry(country)));
    return row?.enabled === true ? row : undefined;
  }
  async upsert(change: FeishuConfigurationChange) {
    const input = feishuConfigurationChange(change),
      existing = await this.exact(input.country);
    this.ensureOpen();
    const currentTime = sql`CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai'`;
    const values = {
      webhookUrl: input.webhookUrl,
      enabled: input.enabled,
      updateTime: currentTime,
    };
    const [row] = existing
      ? await this.db
          .update(feishuConfig)
          .set(values)
          .where(eq(feishuConfig.id, existing.id))
          .returning()
      : await this.db
          .insert(feishuConfig)
          .values({
            country: input.country,
            ...values,
            createTime: currentTime,
          })
          .returning();
    this.ensureOpen();
    if (!row) throw new FeishuConfigurationError('result');
    return validateFeishuRow(row);
  }
  async delete(country: string) {
    await this.exact(feishuCountry(country));
    this.ensureOpen();
    await this.db.delete(feishuConfig).where(matches(country));
    this.ensureOpen();
  }
  async toggle(country: string, enabled: boolean) {
    feishuCountry(country);
    if (typeof enabled !== 'boolean')
      throw new FeishuConfigurationError('input');
    await this.exact(country);
    this.ensureOpen();
    await this.db
      .update(feishuConfig)
      .set({
        enabled,
        updateTime: sql`CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai'`,
      })
      .where(matches(country));
    this.ensureOpen();
    // Return undefined without throwing: Legacy commits disable then returns
    // 404 because this enabled-only read cannot find the disabled configuration.
    return this.find(country);
  }
}
export class PgFeishuConfigurationRepository
  implements FeishuConfigurationRepositoryPort
{
  private active = 0;
  constructor(private readonly pool: Pool) {}
  async transaction<T>(
    action: (unit: FeishuConfigurationUnit) => Promise<T>,
  ): Promise<T> {
    if (this.active >= 16) throw new FeishuConfigurationError('capacity');
    this.active++;
    try {
      return await withAuthDatabaseDeadline(
        this.pool,
        async (db, ensureOpen) => {
          await lockRoleAdministration(db);
          ensureOpen();
          return action(new DrizzleFeishuConfigurationUnit(db, ensureOpen));
        },
      );
    } finally {
      this.active--;
    }
  }
}
