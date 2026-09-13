import { and, eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import type { MonitorAnalyticsQuery } from '../domain/monitor-analytics-query';
import { sessions, users } from '../schema';
import {
  readMonitorAbnormalQuery,
  type MonitorAbnormalQueryOptions,
} from './monitor-abnormal-query';
import { MonitorAnalyticsDeadline } from './monitor-analytics-deadline';
import {
  readMonitorCountQuery,
  readMonitorPeakQuery,
} from './monitor-count-query';
import {
  readMonitorDurationQuery,
  type MonitorDurationQueryOptions,
  type MonitorDurationQueryResult,
} from './monitor-duration-query';
import { readMonitorPeriodQuery } from './monitor-period-query';
import { DrizzleRoleUnit, type RoleWriteUnit } from './role-repository';

export interface MonitorAnalyticsQueryUnit
  extends Pick<
    RoleWriteUnit,
    'lockOperator' | 'lockSession' | 'operatorPermissionCodes'
  > {
  duration(query: MonitorAnalyticsQuery): Promise<MonitorDurationQueryResult>;
  counts(
    query: MonitorAnalyticsQuery,
  ): ReturnType<typeof readMonitorCountQuery>;
  peak(query: MonitorAnalyticsQuery): ReturnType<typeof readMonitorPeakQuery>;
  period(query: MonitorAnalyticsQuery): Promise<MonitorDurationQueryResult>;
  abnormal(
    query: MonitorAnalyticsQuery,
  ): ReturnType<typeof readMonitorAbnormalQuery>;
}
export type MonitorAnalyticsRepositoryOptions = MonitorDurationQueryOptions &
  MonitorAbnormalQueryOptions;
export interface MonitorAnalyticsQueryRepositoryPort {
  read<T>(action: (unit: MonitorAnalyticsQueryUnit) => Promise<T>): Promise<T>;
}
class DrizzleMonitorAnalyticsQueryUnit
  extends DrizzleRoleUnit
  implements MonitorAnalyticsQueryUnit
{
  constructor(
    db: ConstructorParameters<typeof DrizzleRoleUnit>[0],
    ensureOpen: () => void,
    private readonly options: MonitorAnalyticsRepositoryOptions,
  ) {
    super(db, ensureOpen);
  }
  override async lockOperator(userId: string) {
    this.ensureOpen();
    const [row] = await this.db
      .select({
        id: users.id,
        status: users.status,
        lockedUntil: users.lockedUntil,
        forcePasswordChange: users.forcePasswordChange,
        passwordExpiresAt: users.passwordExpiresAt,
      })
      .from(users)
      .where(eq(users.id, userId))
      .for('share');
    this.ensureOpen();
    return row;
  }
  override async lockSession(userId: string, sessionId: string) {
    this.ensureOpen();
    const [row] = await this.db
      .select()
      .from(sessions)
      .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
      .for('share');
    this.ensureOpen();
    return row;
  }
  private async dataPhase() {
    this.ensureOpen();
    // Authentication already ran under the caller's schema and its locks stay
    // held. All analytics relations live explicitly in public. Canonicalize only
    // this phase so Timescale's deparsed definition hashes do not depend on the
    // connection's search_path. SET LOCAL resets at transaction completion.
    await this.db.execute(sql`SET LOCAL search_path TO pg_catalog, public`);
    this.ensureOpen();
    await this.db.execute(sql`SET LOCAL statement_timeout = 5000`);
    this.ensureOpen();
  }
  async duration(query: MonitorAnalyticsQuery) {
    await this.dataPhase();
    return readMonitorDurationQuery(
      this.db,
      query,
      this.ensureOpen,
      this.options,
    );
  }
  async counts(query: MonitorAnalyticsQuery) {
    await this.dataPhase();
    return readMonitorCountQuery(this.db, query, this.ensureOpen);
  }
  async peak(query: MonitorAnalyticsQuery) {
    await this.dataPhase();
    return readMonitorPeakQuery(this.db, query, this.ensureOpen, this.options);
  }
  async period(query: MonitorAnalyticsQuery) {
    await this.dataPhase();
    return readMonitorPeriodQuery(
      this.db,
      query,
      this.ensureOpen,
      this.options,
    );
  }
  async abnormal(query: MonitorAnalyticsQuery) {
    await this.dataPhase();
    return readMonitorAbnormalQuery(
      this.db,
      query,
      this.ensureOpen,
      this.options,
    );
  }
}
export class PgMonitorAnalyticsQueryRepository
  implements MonitorAnalyticsQueryRepositoryPort
{
  private readonly deadline: MonitorAnalyticsDeadline;
  constructor(
    pool: Pool,
    private readonly options: MonitorAnalyticsRepositoryOptions,
  ) {
    this.deadline = new MonitorAnalyticsDeadline(pool);
  }
  read<T>(action: (unit: MonitorAnalyticsQueryUnit) => Promise<T>) {
    return this.deadline.run((db, ensureOpen) =>
      action(
        new DrizzleMonitorAnalyticsQueryUnit(db, ensureOpen, this.options),
      ),
    );
  }
}
