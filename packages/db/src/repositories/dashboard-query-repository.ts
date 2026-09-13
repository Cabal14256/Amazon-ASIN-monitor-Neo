import type { DashboardData } from '@asin-monitor/contracts';
import { and, eq, sql } from 'drizzle-orm';
import type { Pool } from 'pg';
import {
  dashboardDayStart,
  DashboardQueryError,
  mapDashboardData,
  MAX_DASHBOARD_RESPONSE_BYTES,
} from '../domain/dashboard-query';
import {
  asins,
  monitorHistory,
  sessions,
  users,
  variantGroups,
} from '../schema';
import { MonitorAnalyticsDeadline } from './monitor-analytics-deadline';
import { DrizzleRoleUnit, type RoleWriteUnit } from './role-repository';

export interface DashboardQueryUnit
  extends Pick<RoleWriteUnit, 'lockOperator' | 'lockSession'> {
  dashboard(now: Date): Promise<DashboardData>;
}
export interface DashboardQueryRepositoryPort {
  read<T>(operation: (unit: DashboardQueryUnit) => Promise<T>): Promise<T>;
}
class DrizzleDashboardQueryUnit
  extends DrizzleRoleUnit
  implements DashboardQueryUnit
{
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
  async dashboard(now: Date): Promise<DashboardData> {
    const start = dashboardDayStart(now);
    this.ensureOpen();
    await this.db.execute(sql`SET LOCAL statement_timeout = 5000`);
    this.ensureOpen();
    const result = await this.db.execute(sql`
      WITH asin_state AS MATERIALIZED (
        SELECT a.id,a.country,a.variant_group_id,
          (COALESCE(a.is_broken,false) OR COALESCE(a.manual_broken,false)
            OR (COALESCE(g.manual_broken,false) AND NOT COALESCE(a.manual_excluded_from_group,false))) AS broken
        FROM ${asins} a LEFT JOIN ${variantGroups} g
          ON rtrim(g.id) COLLATE public.neo_import_group_ci=rtrim(a.variant_group_id)
      ), broken_parents AS MATERIALIZED (
        SELECT DISTINCT rtrim(variant_group_id) COLLATE public.neo_import_group_ci AS id
        FROM asin_state WHERE broken
      ), group_state AS MATERIALIZED (
        SELECT g.id,g.country,(COALESCE(g.is_broken,false) OR COALESCE(g.manual_broken,false) OR p.id IS NOT NULL) AS broken
        FROM ${variantGroups} g LEFT JOIN broken_parents p
          ON p.id=rtrim(g.id) COLLATE public.neo_import_group_ci
      ), today AS MATERIALIZED (
        SELECT mh.country,mh.is_broken FROM ${monitorHistory} mh
        WHERE mh.check_time>=${start}::timestamp AND rtrim(mh.check_type) COLLATE public.neo_import_group_ci='ASIN'
          AND EXISTS(SELECT 1 FROM ${asins} a WHERE rtrim(a.id) COLLATE public.neo_import_group_ci=rtrim(mh.asin_id))
      ), group_countries AS MATERIALIZED (
        SELECT min(country COLLATE "C") AS country,count(*)::text AS total,count(*) FILTER(WHERE broken)::text AS broken
        FROM group_state GROUP BY rtrim(country) COLLATE public.neo_import_group_ci
      ), asin_countries AS MATERIALIZED (
        SELECT min(country COLLATE "C") AS country,count(*)::text AS total,count(*) FILTER(WHERE broken)::text AS broken
        FROM asin_state GROUP BY rtrim(country) COLLATE public.neo_import_group_ci
      ), today_countries AS MATERIALIZED (
        SELECT min(country COLLATE "C") AS country,count(*)::text AS total,count(*) FILTER(WHERE is_broken)::text AS broken
        FROM today GROUP BY rtrim(country) COLLATE public.neo_import_group_ci
      ), recent_keys AS MATERIALIZED (
        SELECT id,check_time FROM ${monitorHistory} ORDER BY check_time DESC,id DESC LIMIT 20
      ), bounds AS MATERIALIZED (
        SELECT 1048576::bigint + 512::bigint * (
          (SELECT count(*) FROM group_countries)+(SELECT count(*) FROM asin_countries)+(SELECT count(*) FROM today_countries))
          + COALESCE((SELECT sum(2::bigint * COALESCE(octet_length(to_json(mh.check_result::text)::text),4))
            FROM ${monitorHistory} mh JOIN recent_keys k USING(id,check_time)),0) AS bytes,
          (SELECT count(*) FROM ${asins})<>(SELECT count(*) FROM asin_state)
          OR (SELECT count(*)<>count(DISTINCT rtrim(id) COLLATE public.neo_import_group_ci) FROM ${asins})
          OR (SELECT count(*)<>count(DISTINCT rtrim(id) COLLATE public.neo_import_group_ci) FROM ${variantGroups}) AS invalid
      ) SELECT bytes>${MAX_DASHBOARD_RESPONSE_BYTES} AS too_large,invalid,
        CASE WHEN bytes<=${MAX_DASHBOARD_RESPONSE_BYTES} AND NOT invalid THEN jsonb_build_object(
          'overview',jsonb_build_object(
            'totalGroups',(SELECT count(*)::text FROM group_state),'totalASINs',(SELECT count(*)::text FROM asin_state),
            'brokenGroups',(SELECT count(*)::text FROM group_state WHERE broken),'brokenASINs',(SELECT count(*)::text FROM asin_state WHERE broken),
            'todayChecks',(SELECT count(*)::text FROM today),'todayBroken',(SELECT count(*)::text FROM today WHERE is_broken)),
          'groupsByCountry',(SELECT COALESCE(jsonb_agg(to_jsonb(c) ORDER BY country COLLATE public.neo_import_group_ci),'[]'::jsonb) FROM group_countries c),
          'asinsByCountry',(SELECT COALESCE(jsonb_agg(to_jsonb(c)),'[]'::jsonb) FROM asin_countries c),
          'todayByCountry',(SELECT COALESCE(jsonb_agg(to_jsonb(c)),'[]'::jsonb) FROM today_countries c),
          'brokenGroups',(SELECT COALESCE(jsonb_agg(to_jsonb(g)),'[]'::jsonb) FROM (
            SELECT g.id,g.name,g.country,g.site,g.brand,g.variant_status,g.update_time FROM ${variantGroups} g
            JOIN group_state s ON s.id=g.id WHERE s.broken ORDER BY g.update_time DESC NULLS LAST,g.id LIMIT 10) g),
          'brokenASINs',(SELECT COALESCE(jsonb_agg(to_jsonb(a)),'[]'::jsonb) FROM (
            SELECT a.id,a.asin,a.name,a.country,a.site,a.brand,a.variant_status,a.update_time,g.name AS variant_group_name
            FROM ${asins} a JOIN asin_state s ON s.id=a.id LEFT JOIN ${variantGroups} g
              ON rtrim(g.id) COLLATE public.neo_import_group_ci=rtrim(a.variant_group_id)
            WHERE s.broken ORDER BY a.update_time DESC NULLS LAST,a.id LIMIT 10) a),
          'recentActivities',(SELECT COALESCE(jsonb_agg(to_jsonb(mh) || jsonb_build_object(
              'check_result',mh.check_result::text,'variant_group_name',g.name,'asin',a.asin,'asin_name',a.name)
              ORDER BY mh.check_time DESC,mh.id DESC),'[]'::jsonb)
            FROM ${monitorHistory} mh JOIN recent_keys k USING(id,check_time)
            LEFT JOIN ${variantGroups} g ON rtrim(g.id) COLLATE public.neo_import_group_ci=rtrim(mh.variant_group_id)
            LEFT JOIN ${asins} a ON rtrim(a.id) COLLATE public.neo_import_group_ci=rtrim(mh.asin_id))
        ) ELSE NULL END AS data FROM bounds`);
    this.ensureOpen();
    const row = result.rows[0];
    if (!row || row.invalid !== false) throw new DashboardQueryError('result');
    if (row.too_large === true) throw new DashboardQueryError('too-large');
    if (row.too_large !== false) throw new DashboardQueryError('result');
    return mapDashboardData(row.data, this.ensureOpen);
  }
}
export class PgDashboardQueryRepository
  implements DashboardQueryRepositoryPort
{
  private readonly deadline: MonitorAnalyticsDeadline;
  constructor(pool: Pool) {
    this.deadline = new MonitorAnalyticsDeadline(pool);
  }
  read<T>(operation: (unit: DashboardQueryUnit) => Promise<T>) {
    return this.deadline.run((db, ensureOpen) =>
      operation(new DrizzleDashboardQueryUnit(db, ensureOpen)),
    );
  }
}
