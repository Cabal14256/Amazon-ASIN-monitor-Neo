import type {
  HomeWorkbenchData,
  HomeWorkbenchQuery,
} from '@asin-monitor/contracts';
import { and, eq, sql, type SQL } from 'drizzle-orm';
import type { Pool } from 'pg';
import {
  homeWorkbenchDays,
  mapHomeWorkbenchData,
  MAX_HOME_WORKBENCH_FACETS,
  parseHomeWorkbenchQuery,
} from '../domain/home-workbench-query';
import {
  asins,
  monitorHistory,
  sessions,
  users,
  variantGroups,
} from '../schema';
import { formatShanghaiTimestamp } from '../timestamps';
import { MonitorAnalyticsDeadline } from './monitor-analytics-deadline';
import { DrizzleRoleUnit, type RoleWriteUnit } from './role-repository';

export interface HomeWorkbenchQueryUnit
  extends Pick<
    RoleWriteUnit,
    'lockOperator' | 'lockSession' | 'operatorPermissionCodes'
  > {
  workbench(
    query: HomeWorkbenchQuery,
    now: Date,
    trendsAuthorized: boolean,
  ): Promise<HomeWorkbenchData>;
}
export interface HomeWorkbenchQueryRepositoryPort {
  read<T>(operation: (unit: HomeWorkbenchQueryUnit) => Promise<T>): Promise<T>;
}

const groupBroken = sql`(COALESCE(g.is_broken,false) OR COALESCE(g.manual_broken,false)
  OR EXISTS(SELECT 1 FROM ${asins} a WHERE a.variant_group_id=g.id
    AND (COALESCE(a.is_broken,false) OR COALESCE(a.manual_broken,false)
      OR (COALESCE(g.manual_broken,false) AND NOT COALESCE(a.manual_excluded_from_group,false)))))`;
function filters(query: HomeWorkbenchQuery, includeBrand: boolean): SQL {
  return (
    and(
      query.country === undefined
        ? undefined
        : sql`rtrim(g.country) COLLATE public.neo_import_group_ci=rtrim(${query.country}::text) COLLATE public.neo_import_group_ci`,
      query.site === undefined ? undefined : sql`g.site=${query.site}`,
      includeBrand && query.brand !== undefined
        ? sql`g.brand=${query.brand}`
        : undefined,
      query.keyword === undefined
        ? undefined
        : sql`(strpos(lower(g.name),lower(${query.keyword}))>0 OR strpos(lower(g.id),lower(${query.keyword}))>0)`,
      query.status === undefined
        ? undefined
        : query.status === 'BROKEN'
        ? groupBroken
        : sql`NOT ${groupBroken}`,
    ) ?? sql`true`
  );
}

export class DrizzleHomeWorkbenchQueryUnit
  extends DrizzleRoleUnit
  implements HomeWorkbenchQueryUnit
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
  async workbench(
    input: HomeWorkbenchQuery,
    now: Date,
    trendsAuthorized: boolean,
  ) {
    const query = parseHomeWorkbenchQuery(input),
      days = homeWorkbenchDays(now);
    const selectedWhere = filters(query, true),
      facetWhere = and(
        filters(query, false),
        query.facetKeyword === undefined
          ? undefined
          : sql`strpos(lower(g.brand),lower(${query.facetKeyword}))>0`,
      )!;
    // Authorization decides the SQL shape: asin-only readers do not scan or
    // materialize historical rows. No current state is converted into a trend.
    const history = trendsAuthorized
      ? sql`, calendar AS MATERIALIZED (
      SELECT tick.day::date AS day FROM generate_series(${days[0]}::timestamp,${
          days[6]
        }::timestamp,interval '1 day') AS tick(day)
    ), observations AS MATERIALIZED (
      SELECT g.id AS variant_group_id,date_trunc('day',m.check_time)::date AS day,
        count(*)::text AS checks,count(*) FILTER(WHERE m.is_broken=true)::text AS broken_checks,
        count(*) FILTER(WHERE m.is_broken IS NULL)::text AS unknown_checks
      FROM ${monitorHistory} m JOIN selected g ON rtrim(g.id) COLLATE public.neo_import_group_ci=rtrim(m.variant_group_id) COLLATE public.neo_import_group_ci
        AND rtrim(m.country) COLLATE public.neo_import_group_ci=rtrim(g.country) COLLATE public.neo_import_group_ci
      WHERE m.check_time>=${
        days[0]
      }::timestamp AND m.check_time<=${formatShanghaiTimestamp(now)}::timestamp
        AND rtrim(m.check_type) COLLATE public.neo_import_group_ci='GROUP'
      GROUP BY g.id,date_trunc('day',m.check_time)::date
    )`
      : sql``;
    const trend = trendsAuthorized
      ? sql`(SELECT jsonb_agg(jsonb_build_object(
      'day',to_char(c.day,'YYYY-MM-DD'),'checks',COALESCE(o.checks,'0'),
      'broken_checks',COALESCE(o.broken_checks,'0'),'unknown_checks',COALESCE(o.unknown_checks,'0')) ORDER BY c.day)
      FROM calendar c LEFT JOIN observations o ON o.variant_group_id=p.id AND o.day=c.day)`
      : sql`NULL`;
    this.ensureOpen();
    const result = await this.db.execute(sql`
      WITH selected AS MATERIALIZED (
        SELECT g.id,g.name,g.country,g.site,g.brand,g.last_check_time,g.create_time,${groupBroken} AS broken,
          (SELECT count(*)::text FROM ${asins} a WHERE a.variant_group_id=g.id) AS asin_count
        FROM ${variantGroups} g WHERE ${selectedWhere}
        ORDER BY g.create_time DESC NULLS LAST,g.id COLLATE "C" DESC
        LIMIT ${query.pageSize} OFFSET ${(query.current - 1) * query.pageSize}
      ), facet_page AS MATERIALIZED (
        SELECT g.country,g.site,g.brand,count(*)::text AS total_groups
        FROM ${variantGroups} g WHERE ${facetWhere}
        GROUP BY g.country,g.site,g.brand
        ORDER BY count(*) DESC,g.country COLLATE "C",g.site COLLATE "C",g.brand COLLATE "C"
        LIMIT ${MAX_HOME_WORKBENCH_FACETS + 1}
        OFFSET ${(query.facetCurrent - 1) * MAX_HOME_WORKBENCH_FACETS}
      ) ${history}
      SELECT (SELECT count(*)::text FROM ${variantGroups} g WHERE ${selectedWhere}) AS total,
        COALESCE((SELECT jsonb_agg(to_jsonb(f) ORDER BY f.total_groups::bigint DESC,f.country COLLATE "C",f.site COLLATE "C",f.brand COLLATE "C") FROM facet_page f),'[]'::jsonb) AS facets,
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'id',p.id,'name',p.name,'country',p.country,'site',p.site,'brand',p.brand,
          'broken',p.broken,'asin_count',p.asin_count,'last_check_time',p.last_check_time,'trend',${trend})
          ORDER BY p.create_time DESC NULLS LAST,p.id COLLATE "C" DESC) FROM selected p),'[]'::jsonb) AS list`);
    this.ensureOpen();
    return mapHomeWorkbenchData(result.rows[0], query, now, trendsAuthorized);
  }
}
export class PgHomeWorkbenchQueryRepository
  implements HomeWorkbenchQueryRepositoryPort
{
  private readonly deadline: MonitorAnalyticsDeadline;
  constructor(pool: Pool) {
    this.deadline = new MonitorAnalyticsDeadline(pool);
  }
  read<T>(operation: (unit: HomeWorkbenchQueryUnit) => Promise<T>) {
    return this.deadline.run((db, ensureOpen) =>
      operation(new DrizzleHomeWorkbenchQueryUnit(db, ensureOpen)),
    );
  }
}
