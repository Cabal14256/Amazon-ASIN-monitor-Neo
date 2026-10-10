import {
  currentUserResultSchema,
  homeWorkbenchResultSchema,
  type HomeWorkbenchData,
} from '@asin-monitor/contracts';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { HomeWorkbenchModule } from '../src/home-workbench/home-workbench.module';
import { spApiConfigApp } from './helpers/sp-api-config-app';

// Opt-in alone is insufficient: check the disposable database names and local
// endpoints before the shared fixture can connect or create its private schema.
function requireDisposableServices() {
  if (
    process.env.RUN_INTEGRATION_TESTS !== 'true' ||
    process.env.INTEGRATION_ALLOW_DROP_DATABASES !== 'true' ||
    process.env.TIMESCALE_PERFORMANCE_DISPOSABLE_DATABASE !==
      'amazon_asin_monitor_ci'
  )
    throw new Error(
      'Home workbench requires explicitly disposable CI services',
    );
  for (const [key, database] of [
    ['DATABASE_URL', 'amazon_asin_monitor_ci'],
    ['COMPETITOR_DATABASE_URL', 'amazon_competitor_monitor_ci'],
  ] as const) {
    const url = new URL(process.env[key] ?? '');
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      decodeURIComponent(url.pathname.slice(1)) !== database
    )
      throw new Error(
        'Home workbench database is not the disposable CI target',
      );
  }
  const redis = new URL(process.env.REDIS_URL ?? '');
  if (
    !['redis:', 'rediss:'].includes(redis.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(redis.hostname) ||
    redis.pathname !== '/15'
  )
    throw new Error('Home workbench Redis is not the disposable CI target');
}

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'Home workbench / real isolated PostgreSQL, Redis, JWT and HTTP',
  () => {
    let f: Awaited<ReturnType<typeof spApiConfigApp>> | undefined;
    let headers: { authorization: string };
    let verifiedDatabase = false;
    let domainTablesCreated = false;
    const suffix = randomUUID().replace(/-/g, '').slice(0, 20);
    const prefix = `home228-${suffix}`;
    const site = ` ${prefix}.site `;
    const roleId = `${prefix}-role`;
    const ownerId = randomUUID();
    const sessionId = randomUUID();
    const now = '2026-10-06T16:05:06.123Z';
    const days = [
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
      '2026-10-04',
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
    ];
    // These are separate legal literal IDs and exact brands, including the
    // trim-neighbour; no fixture normalizes a catalog identity or metadata.
    const groups = [
      { id: ` ${prefix}-empty `, name: ' 空品牌原名😀 ', brand: '' },
      { id: ` ${prefix}-padded `, name: ' Raw group name ', brand: ' Raw ' },
      { id: `${prefix}-trimmed`, name: 'Trim neighbour', brand: 'Raw' },
      { id: `${prefix}-space`, name: 'Single-space brand', brand: ' ' },
    ];
    const asinIds = [0, 1].map((index) => `${prefix}-asin-${index}`);

    function fixture() {
      if (!f || !verifiedDatabase)
        throw new Error('Home fixture was not verified before use');
      return f;
    }
    async function grants(codes: readonly string[]) {
      const active = fixture();
      await active.pools.primaryPool.query(
        'DELETE FROM role_permissions WHERE role_id=$1',
        [roleId],
      );
      const granted = await active.pools.primaryPool.query(
        'INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code=ANY($2::text[]) RETURNING permission_id',
        [roleId, codes],
      );
      expect(granted.rowCount).toBe(codes.length);
    }
    beforeAll(async () => {
      requireDisposableServices();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date(now));
      f = await spApiConfigApp({
        imports: [HomeWorkbenchModule],
        env: { BULL_PREFIX: prefix },
      });
      const database = await f.pools.primaryPool.query(
        'SELECT current_database() AS name, current_schema() AS schema',
      );
      expect(database.rows[0]).toEqual({
        name: 'amazon_asin_monitor_ci',
        schema: f.schema,
      });
      verifiedDatabase = true;
      await f.redis.ping();
      for (const table of ['variant_groups', 'asins', 'monitor_history'])
        await f.pools.primaryPool.query(
          `CREATE TABLE "${table}" (LIKE public."${table}" INCLUDING ALL)`,
        );
      domainTablesCreated = true;
      // Unique role/owner/session: reader-71 and every shared permission grant
      // remain unchanged. The private schema has no public search_path fallback.
      await f.pools.primaryPool.query(
        'INSERT INTO roles(id,code,name) VALUES($1,$1,$2)',
        [roleId, 'Home fixture reader'],
      );
      f.userIds.add(ownerId);
      await f.pools.primaryPool.query(
        'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$1,$2,false)',
        [ownerId, 'fixture-unused-hash'],
      );
      await f.pools.primaryPool.query(
        'INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)',
        [ownerId, roleId],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,'2099-01-01 08:00:00')",
        [sessionId, ownerId],
      );
      headers = {
        authorization: `Bearer ${jwt.sign(
          { userId: ownerId, sessionId },
          f.env.JWT_SECRET,
          { expiresIn: '1h' },
        )}`,
      };
      for (const [index, group] of groups.entries()) {
        expect([...group.id].length).toBeLessThanOrEqual(50);
        await f.pools.primaryPool.query(
          "INSERT INTO variant_groups(id,name,country,site,brand,create_time,last_check_time) VALUES($1,$2,'US',$3,$4,$5,'2026-10-07 00:03:00')",
          [
            group.id,
            group.name,
            site,
            group.brand,
            `2026-10-06 09:00:0${3 - index}`,
          ],
        );
      }
      for (const [index, id] of asinIds.entries())
        await f.pools.primaryPool.query(
          "INSERT INTO asins(id,asin,name,country,site,brand,variant_group_id,is_broken) VALUES($1,$2,$3,'US',$4,'',$5,$6)",
          [
            id,
            `B${suffix.slice(0, 8)}${index}`,
            ` ASIN ${index} `,
            site,
            groups[0].id,
            index === 1,
          ],
        );
      const observations: [string, string, string, boolean | null][] = [
        ['2026-10-01 00:00:00', 'GROUP', 'US', false],
        ['2026-10-06 23:59:59', 'gRoUp ', 'us', null],
        ['2026-10-07 00:00:00', 'GROUP', 'US', true],
        ['2026-10-07 00:04:00', 'GROUP', 'US', false],
        // Negative controls share the same group: ASIN/country/out-of-window
        // observations must not be relabelled as a current group trend.
        ['2026-10-07 00:01:00', 'ASIN', 'US', true],
        ['2026-10-07 00:01:00', 'GROUP', 'UK', true],
        ['2026-09-30 23:59:59', 'GROUP', 'US', true],
        ['2026-10-07 00:05:07', 'GROUP', 'US', true],
        ['2026-10-07 00:01:00', 'custom', 'US', null],
      ];
      for (const [time, type, country, broken] of observations)
        await f.pools.primaryPool.query(
          'INSERT INTO monitor_history(variant_group_id,variant_group_name,asin_id,asin_code,country,check_type,is_broken,check_time,check_result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',
          [
            groups[0].id,
            'Historical name remains historical',
            asinIds[0],
            `B${suffix.slice(0, 8)}0`,
            country,
            type,
            broken,
            time,
            JSON.stringify({ original: true }),
          ],
        );
    });
    beforeEach(async () => {
      await grants(['asin:read', 'monitor:read']);
    });
    afterAll(async () => {
      try {
        if (f && verifiedDatabase && domainTablesCreated) {
          const database = await f.pools.primaryPool.query(
            'SELECT current_database() AS name, current_schema() AS schema',
          );
          expect(database.rows[0]).toEqual({
            name: 'amazon_asin_monitor_ci',
            schema: f.schema,
          });
          // Only deterministic fixture IDs, in the already verified private
          // schema. The helper subsequently removes its own schema and the
          // auth Redis keys it recorded for this UUID owner, then closes pools.
          await f.pools.primaryPool.query(
            'DELETE FROM monitor_history WHERE variant_group_id=ANY($1::text[])',
            [groups.map((group) => group.id)],
          );
          await f.pools.primaryPool.query(
            'DELETE FROM asins WHERE id=ANY($1::text[])',
            [asinIds],
          );
          await f.pools.primaryPool.query(
            'DELETE FROM variant_groups WHERE id=ANY($1::text[])',
            [groups.map((group) => group.id)],
          );
          await f.pools.primaryPool.query(
            'DELETE FROM sessions WHERE id=$1 AND user_id=$2',
            [sessionId, ownerId],
          );
          await f.pools.primaryPool.query(
            'DELETE FROM user_roles WHERE user_id=$1 AND role_id=$2',
            [ownerId, roleId],
          );
          await f.pools.primaryPool.query(
            'DELETE FROM role_permissions WHERE role_id=$1',
            [roleId],
          );
          await f.pools.primaryPool.query('DELETE FROM roles WHERE id=$1', [
            roleId,
          ]);
          await f.pools.primaryPool.query('DELETE FROM users WHERE id=$1', [
            ownerId,
          ]);
        }
      } finally {
        try {
          if (f) await f.close();
        } finally {
          vi.useRealTimers();
          vi.restoreAllMocks();
        }
      }
    });
    const get = (
      raw: Record<string, string> = {},
      auth: Record<string, string> = headers,
    ) =>
      fixture().http.inject({
        method: 'GET',
        url:
          '/api/v1/dashboard/workbench?' +
          new URLSearchParams({ site, ...raw }),
        headers: auth,
      });
    async function read(raw: Record<string, string> = {}) {
      const response = await get(raw);
      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      return homeWorkbenchResultSchema.parse(response.json());
    }
    function expected(
      selected = groups,
      authorized = true,
    ): { success: true; errorCode: 0; data: HomeWorkbenchData } {
      return {
        success: true,
        errorCode: 0,
        data: {
          generatedAt: now,
          days,
          current: 1,
          pageSize: 10,
          total: selected.length,
          facetCurrent: 1,
          facetsTruncated: false,
          trendsAuthorized: authorized,
          facets: [groups[0], groups[3], groups[1], groups[2]].map((group) => ({
            country: 'US',
            site,
            brand: group.brand,
            totalGroups: 1,
          })),
          list: selected.map((group) => ({
            ...group,
            country: 'US',
            site,
            asinCount: group.id === groups[0].id ? 2 : 0,
            isBroken: group.id === groups[0].id,
            lastCheckTime: '2026-10-06T16:03:00.000Z',
            trend: !authorized
              ? null
              : days.map((day) => ({
                  day,
                  checks:
                    group.id !== groups[0].id
                      ? 0
                      : day === '2026-10-01' || day === '2026-10-06'
                      ? 1
                      : day === '2026-10-07'
                      ? 2
                      : 0,
                  brokenChecks:
                    group.id === groups[0].id && day === '2026-10-07' ? 1 : 0,
                  unknownChecks:
                    group.id === groups[0].id && day === '2026-10-06' ? 1 : 0,
                })),
          })),
        },
      };
    }
    async function primePermissionCache() {
      const active = fixture();
      const response = await active.http.inject({
        method: 'GET',
        url: '/api/v1/auth/current-user',
        headers,
      });
      expect(response.statusCode, response.body).toBe(200);
      const identity = currentUserResultSchema.parse(response.json());
      expect(identity.data?.user.id).toBe(ownerId);
      const generation =
        (await active.redis.get('neo:auth:cache-generation')) ?? '0';
      const key = `neo:auth:${generation}:permissions:${ownerId}`;
      const raw = await active.redis.get(key);
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!)).toContain('asin:read');
      return { key, raw };
    }

    it('keeps empty/padded/trim-neighbour brands and complete original metadata distinct through HTTP and SQL', async () => {
      expect(await read()).toEqual(expected());
      for (const group of groups)
        expect(await read({ country: 'us', brand: group.brand })).toEqual(
          expected([group]),
        );
    });
    it('returns Shanghai seven-day GROUP observations, including unknowns, without ASIN/country/window contamination', async () => {
      const actual = await read({ brand: '' });
      expect(actual).toEqual(expected([groups[0]]));
      expect(actual.data?.list[0].trend).toEqual([
        { day: '2026-10-01', checks: 1, brokenChecks: 0, unknownChecks: 0 },
        { day: '2026-10-02', checks: 0, brokenChecks: 0, unknownChecks: 0 },
        { day: '2026-10-03', checks: 0, brokenChecks: 0, unknownChecks: 0 },
        { day: '2026-10-04', checks: 0, brokenChecks: 0, unknownChecks: 0 },
        { day: '2026-10-05', checks: 0, brokenChecks: 0, unknownChecks: 0 },
        { day: '2026-10-06', checks: 1, brokenChecks: 0, unknownChecks: 1 },
        { day: '2026-10-07', checks: 2, brokenChecks: 1, unknownChecks: 0 },
      ]);
    });
    it('combines case and trailing-padding history aliases under the exact selected catalog ID without merging leading-space neighbours', async () => {
      const observations: [string, string, string, string, boolean | null][] = [
        [
          groups[0].id.toUpperCase(),
          '2026-10-07 00:01:00',
          'GROUP',
          'US',
          false,
        ],
        [
          `${groups[0].id.toUpperCase()}  `,
          '2026-10-07 00:02:00',
          'gRoUp ',
          'us',
          true,
        ],
        [groups[0].id.trimEnd(), '2026-10-07 00:03:00', 'GROUP', 'US', null],
        [
          groups[1].id.toUpperCase(),
          '2026-10-07 00:03:00',
          'GROUP',
          'US',
          true,
        ],
        [groups[0].id.trimStart(), '2026-10-07 00:01:00', 'GROUP', 'US', true],
        [groups[0].id.toUpperCase(), '2026-10-07 00:01:00', 'ASIN', 'US', true],
        [
          groups[0].id.toUpperCase(),
          '2026-10-07 00:01:00',
          'GROUP',
          'UK',
          true,
        ],
        [
          groups[0].id.toUpperCase(),
          '2026-09-30 23:59:59',
          'GROUP',
          'US',
          true,
        ],
        [
          groups[0].id.toUpperCase(),
          '2026-10-07 00:05:07',
          'GROUP',
          'US',
          true,
        ],
      ];
      const insertedIds: string[] = [];
      try {
        for (const [groupId, time, type, country, broken] of observations) {
          const inserted = await fixture().pools.primaryPool.query<{
            id: string;
          }>(
            'INSERT INTO monitor_history(variant_group_id,variant_group_name,asin_id,asin_code,country,check_type,is_broken,check_time,check_result) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING id::text',
            [
              groupId,
              'Alias history keeps the original catalog identity',
              asinIds[0],
              `B${suffix.slice(0, 8)}0`,
              country,
              type,
              broken,
              time,
              JSON.stringify({ alias: true }),
            ],
          );
          insertedIds.push(inserted.rows[0].id);
        }
        const expectedData = expected();
        expectedData.data.list[0].trend![6] = {
          day: '2026-10-07',
          checks: 5,
          brokenChecks: 2,
          unknownChecks: 1,
        };
        expectedData.data.list[1].trend![6] = {
          day: '2026-10-07',
          checks: 1,
          brokenChecks: 1,
          unknownChecks: 0,
        };
        expect(await read()).toEqual(expectedData);
        expect((await read({ brand: '' })).data?.list).toEqual([
          expectedData.data.list[0],
        ]);
      } finally {
        if (insertedIds.length)
          await fixture().pools.primaryPool.query(
            'DELETE FROM monitor_history WHERE id=ANY($1::bigint[])',
            [insertedIds],
          );
      }
    });
    it('matches padded migrated countries without changing returned catalog metadata or admitting leading-space neighbours', async () => {
      const originals = await fixture().pools.primaryPool.query<{
        id: string;
        country: string;
      }>(
        "SELECT id::text,country FROM monitor_history WHERE variant_group_id=$1 AND lower(country)='us'",
        [groups[0].id],
      );
      const historyIds = originals.rows.map((row) => row.id);
      try {
        await fixture().pools.primaryPool.query(
          "UPDATE variant_groups SET country='uS  ' WHERE id=$1",
          [groups[0].id],
        );
        await fixture().pools.primaryPool.query(
          "UPDATE monitor_history SET country='US ' WHERE id=ANY($1::bigint[])",
          [historyIds],
        );
        const padded = expected([groups[0]]);
        padded.data.list[0].country = 'uS  ';
        padded.data.facets = [groups[3], groups[1], groups[2], groups[0]].map(
          (group) => ({
            country: group.id === groups[0].id ? 'uS  ' : 'US',
            site,
            brand: group.brand,
            totalGroups: 1,
          }),
        );
        expect(await read({ country: 'us', brand: '' })).toEqual(padded);
        await fixture().pools.primaryPool.query(
          "UPDATE variant_groups SET country=' US' WHERE id=$1",
          [groups[0].id],
        );
        const leading = expected([]);
        leading.data.facets = expected().data.facets.filter(
          (facet) => facet.brand !== '',
        );
        expect(await read({ country: 'US', brand: '' })).toEqual(leading);
      } finally {
        await fixture().pools.primaryPool.query(
          "UPDATE variant_groups SET country='US' WHERE id=$1",
          [groups[0].id],
        );
        for (const original of originals.rows)
          await fixture().pools.primaryPool.query(
            'UPDATE monitor_history SET country=$2 WHERE id=$1::bigint',
            [original.id, original.country],
          );
      }
    });
    it('uses current monitor/analytics grants and returns null trends after their withdrawal despite real cached permissions', async () => {
      const cached = await primePermissionCache();
      expect(JSON.parse(cached.raw!)).toContain('monitor:read');
      expect(await read({ brand: '' })).toEqual(expected([groups[0]]));
      await grants(['asin:read']);
      expect(await read({ brand: '' })).toEqual(expected([groups[0]], false));
      expect(await fixture().redis.get(cached.key)).toBe(cached.raw);
      await grants(['asin:read', 'analytics:read']);
      expect(await read({ brand: '' })).toEqual(expected([groups[0]]));
      await grants(['asin:read']);
      expect(await read({ brand: '' })).toEqual(expected([groups[0]], false));
    });
    it('denies revoked ASIN permission under current transaction authorization without trusting the Redis grant', async () => {
      const cached = await primePermissionCache();
      expect(await read({ brand: '' })).toEqual(expected([groups[0]]));
      await grants(['monitor:read']);
      const denied = await get({ brand: '' });
      expect(denied.statusCode, denied.body).toBe(403);
      expect(denied.headers['cache-control']).toBe('no-store');
      expect(denied.json()).toEqual({
        success: false,
        errorCode: 403,
        errorMessage: '没有权限执行此操作',
      });
      expect(await fixture().redis.get(cached.key)).toBe(cached.raw);
    });
    it('rejects anonymous and schema-invalid reads while leaving private catalog and observations intact', async () => {
      expect((await get({}, {})).statusCode).toBe(401);
      const invalidQueries: Record<string, string>[] = [
        { current: '1001' },
        { current: '502', pageSize: '20' },
        { pageSize: '21' },
        { facetCurrent: '52' },
        { brand: '\u0000' },
        { site: '' },
        { unexpected: 'value' },
      ];
      for (const invalid of invalidQueries) {
        const response = await get(invalid);
        expect(response.statusCode, response.body).toBe(400);
        expect(response.json()).toEqual({
          success: false,
          errorCode: 400,
          errorMessage: '首页筛选参数无效，请减少页数或缩小筛选范围',
        });
      }
      const counts = await fixture().pools.primaryPool.query(
        'SELECT (SELECT count(*)::text FROM variant_groups WHERE id=ANY($1::text[])) AS groups,(SELECT count(*)::text FROM asins WHERE id=ANY($2::text[])) AS asins,(SELECT count(*)::text FROM monitor_history WHERE variant_group_id=ANY($1::text[])) AS history',
        [groups.map((group) => group.id), asinIds],
      );
      expect(counts.rows[0]).toEqual({ groups: '4', asins: '2', history: '9' });
    });
  },
);
