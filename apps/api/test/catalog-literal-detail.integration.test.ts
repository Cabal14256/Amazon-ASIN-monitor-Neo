import {
  competitorGroupResultSchema,
  variantGroupResultSchema,
} from '@asin-monitor/contracts';
import {
  createPgPool,
  type AsinQueryRepositoryPort,
  type CompetitorQueryRepositoryPort,
} from '@asin-monitor/db';
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
import { ASIN_QUERY_REPOSITORY } from '../src/asin/asin-query.service';
import { AsinModule } from '../src/asin/asin.module';
import { COMPETITOR_QUERY_REPOSITORY } from '../src/competitor/competitor-query.service';
import { CompetitorModule } from '../src/competitor/competitor.module';
import { spApiConfigApp } from './helpers/sp-api-config-app';

function requireDisposableTargets() {
  if (
    process.env.RUN_INTEGRATION_TESTS !== 'true' ||
    process.env.INTEGRATION_ALLOW_DROP_DATABASES !== 'true' ||
    process.env.TIMESCALE_PERFORMANCE_DISPOSABLE_DATABASE !==
      'amazon_asin_monitor_ci'
  )
    throw new Error(
      'Enable the explicit disposable literal-detail integration targets',
    );
  for (const [key, database] of [
    ['DATABASE_URL', 'amazon_asin_monitor_ci'],
    ['COMPETITOR_DATABASE_URL', 'amazon_competitor_monitor_ci'],
  ] as const) {
    const url = new URL(process.env[key] ?? 'invalid:');
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.pathname !== `/${database}`
    )
      throw new Error(
        'Literal-detail integration requires the exact local disposable PostgreSQL databases',
      );
  }
  const redis = new URL(process.env.REDIS_URL ?? 'invalid:');
  if (
    !['redis:', 'rediss:'].includes(redis.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(redis.hostname) ||
    redis.pathname !== '/15'
  )
    throw new Error(
      'Literal-detail integration requires local disposable Redis database 15',
    );
}

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'Neo literal group detail / actual Fastify, PostgreSQL and Redis',
  () => {
    let f: Awaited<ReturnType<typeof spApiConfigApp>> | undefined;
    let competitorAdmin: ReturnType<typeof createPgPool> | undefined;
    let competitorSchema: string | undefined;
    let userId: string,
      sessionId: string,
      headers: { authorization: string },
      childCode = 0;
    const schemaName = () => {
      if (
        !competitorSchema ||
        !/^literal_detail_242_[0-9a-f]{32}$/.test(competitorSchema)
      )
        throw new Error('Unsafe literal-detail private schema');
      return `"${competitorSchema}"`;
    };
    const close = async () => {
      try {
        await f?.close();
      } finally {
        try {
          if (competitorAdmin && competitorSchema)
            await competitorAdmin.query(
              `DROP SCHEMA IF EXISTS ${schemaName()} CASCADE`,
            );
        } finally {
          await competitorAdmin?.end();
        }
      }
    };
    beforeAll(async () => {
      // This guard runs before any helper creates a pool or connects to Redis.
      requireDisposableTargets();
      try {
        competitorAdmin = createPgPool(process.env.COMPETITOR_DATABASE_URL!, {
          max: 2,
          connectionTimeoutMillis: 2000,
        });
        competitorSchema = `literal_detail_242_${randomUUID().replace(
          /-/g,
          '',
        )}`;
        await competitorAdmin.query(`CREATE SCHEMA ${schemaName()}`);
        for (const table of ['competitor_variant_groups', 'competitor_asins'])
          await competitorAdmin.query(
            `CREATE TABLE ${schemaName()}.${table} (LIKE public.${table} INCLUDING ALL)`,
          );
        const competitorURL = new URL(process.env.COMPETITOR_DATABASE_URL!);
        competitorURL.searchParams.set(
          'options',
          `-c search_path=${competitorSchema}`,
        );
        f = await spApiConfigApp({
          imports: [AsinModule, CompetitorModule],
          env: { COMPETITOR_DATABASE_URL: competitorURL.toString() },
        });
        for (const table of ['variant_groups', 'asins'])
          await f.pools.primaryPool.query(
            `CREATE TABLE ${table} (LIKE public.${table} INCLUDING ALL)`,
          );
        await f.pools.primaryPool.query(
          "INSERT INTO role_permissions(role_id,permission_id) SELECT 'reader-71',id FROM permissions WHERE code='asin:read'",
        );
        expect(
          (
            await f.pools.competitorPool.query(
              'SELECT current_schema() AS name',
            )
          ).rows[0].name,
        ).toBe(competitorSchema);
        expect(
          (
            await f.pools.competitorPool.query(
              "SELECT to_regclass('users') AS value",
            )
          ).rows[0].value,
        ).toBeNull();
        expect(
          (await f.pools.primaryPool.query('SELECT current_database() AS name'))
            .rows[0].name,
        ).not.toBe(
          (
            await f.pools.competitorPool.query(
              'SELECT current_database() AS name',
            )
          ).rows[0].name,
        );
      } catch (error) {
        await close();
        f = undefined;
        competitorAdmin = undefined;
        throw error;
      }
    });
    afterAll(async () => {
      try {
        await close();
      } finally {
        vi.restoreAllMocks();
      }
    });
    beforeEach(async () => {
      if (!f) throw new Error('Literal-detail fixture did not initialize');
      await f.pools.primaryPool.query('DELETE FROM asins');
      await f.pools.primaryPool.query('DELETE FROM variant_groups');
      await f.pools.competitorPool.query('DELETE FROM competitor_asins');
      await f.pools.competitorPool.query(
        'DELETE FROM competitor_variant_groups',
      );
      userId = randomUUID();
      sessionId = randomUUID();
      f.userIds.add(userId);
      await f.pools.primaryPool.query(
        'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$1,$2,false)',
        [userId, 'fixture-unused-hash'],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO user_roles(user_id,role_id) VALUES($1,'reader-71')",
        [userId],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,'2099-01-01 08:00:00')",
        [sessionId, userId],
      );
      headers = {
        authorization: `Bearer ${jwt.sign(
          { userId, sessionId },
          f.env.JWT_SECRET,
          { expiresIn: '1h' },
        )}`,
      };
    });
    const db = (domain: 'primary' | 'competitor') =>
      domain === 'primary' ? f!.pools.primaryPool : f!.pools.competitorPool;
    const groups = (domain: 'primary' | 'competitor') =>
      domain === 'primary' ? 'variant_groups' : 'competitor_variant_groups';
    const asins = (domain: 'primary' | 'competitor') =>
      domain === 'primary' ? 'asins' : 'competitor_asins';
    const oldPath = (domain: 'primary' | 'competitor') =>
      domain === 'primary'
        ? '/api/v1/variant-groups'
        : '/api/v1/competitor/variant-groups';
    const neoPath = (domain: 'primary' | 'competitor') =>
      domain === 'primary'
        ? '/api/v1/catalog/variant-groups/detail'
        : '/api/v1/competitor/catalog/variant-groups/detail';
    const read = (
      domain: 'primary' | 'competitor',
      id: string,
      auth = headers,
    ) =>
      f!.http.inject({
        method: 'GET',
        url: `${neoPath(domain)}?${new URLSearchParams({ groupId: id })}`,
        headers: auth,
      });
    const legacyRead = (domain: 'primary' | 'competitor', id: string) =>
      f!.http.inject({
        method: 'GET',
        url: `${oldPath(domain)}/${encodeURIComponent(id)}`,
        headers,
      });
    async function group(
      domain: 'primary' | 'competitor',
      id: string,
      name = 'Original literal target',
    ) {
      const site = domain === 'primary' ? ',site' : '';
      const siteValue = domain === 'primary' ? ",'amazon.com'" : '';
      await db(domain).query(
        `INSERT INTO ${groups(
          domain,
        )}(id,name,country,brand${site}) VALUES($1,$2,'US','Fixture'${siteValue})`,
        [id, name],
      );
    }
    async function child(
      domain: 'primary' | 'competitor',
      id: string,
      parent: string,
    ) {
      const site = domain === 'primary' ? ',site' : '';
      const siteValue = domain === 'primary' ? ",'amazon.com'" : '';
      await db(domain).query(
        `INSERT INTO ${asins(
          domain,
        )}(id,asin,name,country,brand,variant_group_id${site}) VALUES($1,$4,$2,'US','Fixture',$3${siteValue})`,
        [
          id,
          'Literal child',
          parent,
          `B${String(++childCode).padStart(9, '0')}`,
        ],
      );
    }
    const literalUnitRead = (domain: 'primary' | 'competitor', id: string) => {
      // Proposed compatible port extension: the existing one-argument Legacy
      // detail mode remains unchanged. Before implementation JS ignores the
      // explicit extra mode, so these tests exercise the actual original SQL.
      if (domain === 'primary')
        return f!.app
          .get<AsinQueryRepositoryPort>(ASIN_QUERY_REPOSITORY)
          .read((unit) =>
            (
              unit.detail as (
                id: string,
                mode: 'literal',
              ) => ReturnType<typeof unit.detail>
            ).call(unit, id, 'literal'),
          );
      return f!.app
        .get<CompetitorQueryRepositoryPort>(COMPETITOR_QUERY_REPOSITORY)
        .read((unit) =>
          (
            unit.detail as (
              id: string,
              mode: 'literal',
            ) => ReturnType<typeof unit.detail>
          ).call(unit, id, 'literal'),
        );
    };

    describe.each(['primary', 'competitor'] as const)(
      '%s exact domain and raw key',
      (domain) => {
        it('proves literal mode against the original real SQL independently of the new HTTP route', async () => {
          await group(domain, ' ');
          await child(domain, 'space-child', ' ');
          const spaces = await literalUnitRead(domain, ' ');
          expect(spaces.groups.map((row) => row.id)).toEqual([' ']);
          expect(spaces.asins.map((row) => row.id)).toEqual(['space-child']);
          await db(domain).query(`DELETE FROM ${asins(domain)}`);
          await db(domain).query(`DELETE FROM ${groups(domain)}`);
          await group(domain, 'Raw');
          await child(domain, 'exact-child', 'Raw');
          for (const missing of ['raw', 'Raw ', ' Raw'])
            expect((await literalUnitRead(domain, missing)).groups).toEqual([]);
          expect(
            (await literalUnitRead(domain, 'Raw')).groups.map((row) => row.id),
          ).toEqual(['Raw']);
        });
        it('returns only exact-parent native unit children independently of the existing mapper', async () => {
          await group(domain, 'Raw');
          for (const [id, parent] of [
            ['exact-child', 'Raw'],
            ['case-child', 'raw'],
            ['pad-child', 'Raw '],
            ['unrelated-child', 'Elsewhere'],
          ])
            await child(domain, id, parent);
          const actual = await literalUnitRead(domain, 'Raw');
          expect(actual.asins.map((row) => row.id)).toEqual(['exact-child']);
          expect(actual.asins[0].variantGroupId).toBe('Raw');
        });
        it('reads all legal literals and complete exact-parent children without altering the production unique indexes', async () => {
          for (const id of [
            'group-normal',
            ' Source Ś ',
            ' ',
            '.',
            '..',
            'a/b',
            'a?b',
            'a#b',
            'a\\b',
            '中文🔎',
            '🔎'.repeat(50),
            'a%b',
            'a+b',
            'a=b',
            'a,b',
          ]) {
            await db(domain).query(`DELETE FROM ${asins(domain)}`);
            await db(domain).query(`DELETE FROM ${groups(domain)}`);
            await group(domain, id);
            await child(domain, ' Child /?# ', id);
            await child(domain, 'unrelated-child', 'unrelated-parent');
            const response = await read(domain, id);
            expect(response.statusCode).toBe(200);
            expect(response.headers['cache-control']).toBe('no-store');
            (domain === 'primary'
              ? variantGroupResultSchema
              : competitorGroupResultSchema
            ).parse(response.json());
            expect(response.json().data).toMatchObject({
              id,
              name: 'Original literal target',
              children: [{ id: ' Child /?# ', parentId: id }],
            });
            expect(response.json().data.children).toHaveLength(1);
          }
        });
        it('returns 404 for absent trim and case neighbors while retaining existing path matching', async () => {
          await group(domain, 'Raw');
          await child(domain, 'child-exact', 'Raw');
          for (const missing of [
            'raw',
            'RAW',
            'Raw ',
            ' Raw',
            '\u00a0Raw\u00a0',
          ])
            expect((await read(domain, missing)).statusCode).toBe(404);
          expect((await read(domain, 'Raw')).json().data.id).toBe('Raw');
          for (const neighbor of ['raw', 'RAW', 'Raw ']) {
            const old = await legacyRead(domain, neighbor);
            expect(old.statusCode).toBe(domain === 'competitor' ? 200 : 404);
            if (domain === 'competitor') expect(old.json().data.id).toBe('Raw');
          }
        });
        it('isolates exact child parentId while preserving the original repository association mode', async () => {
          await group(domain, 'Raw');
          for (const [id, parent] of [
            ['exact-child', 'Raw'],
            ['case-child', 'raw'],
            ['pad-child', 'Raw '],
            ['leading-child', ' Raw'],
            ['unrelated-child', 'Elsewhere'],
          ])
            await child(domain, id, parent);
          // Existing repository mode remains the Legacy compatibility oracle.
          const result =
            domain === 'primary'
              ? await f!.app
                  .get<AsinQueryRepositoryPort>(ASIN_QUERY_REPOSITORY)
                  .read((unit) => unit.detail('Raw'))
              : await f!.app
                  .get<CompetitorQueryRepositoryPort>(
                    COMPETITOR_QUERY_REPOSITORY,
                  )
                  .read((unit) => unit.detail('Raw'));
          expect(result.asins.map((row) => row.id).sort()).toEqual(
            domain === 'primary'
              ? ['exact-child']
              : ['case-child', 'exact-child', 'pad-child'],
          );
          const response = await read(domain, 'Raw');
          expect(response.statusCode).toBe(200);
          expect(
            response.json().data.children.map((row: { id: string }) => row.id),
          ).toEqual(['exact-child']);
          expect(response.json().data.children[0].parentId).toBe('Raw');
        });
        it('preserves old real IDs detail/by-id and raw padded Unicode through existing path and list routes', async () => {
          for (const id of ['detail', 'by-id', ' Source Ś ']) {
            await group(domain, id);
            await child(domain, `child-${id}`, id);
            const response = await legacyRead(domain, id);
            expect(response.statusCode).toBe(200);
            expect(response.json().data.id).toBe(id);
          }
          const list = await f!.http.inject({
            method: 'GET',
            url: oldPath(domain),
            headers,
          });
          expect(list.statusCode).toBe(200);
          expect(list.json().data.total).toBe(3);
        });
        it('denies committed read permission revocation after real Redis guard cache was primed', async () => {
          await group(domain, 'Raw');
          expect((await legacyRead(domain, 'Raw')).statusCode).toBe(200);
          await f!.pools.primaryPool.query(
            'DELETE FROM user_roles WHERE user_id=$1',
            [userId],
          );
          expect((await read(domain, 'Raw')).statusCode).toBe(403);
        });
        it('denies a foreign session owner and revoked current session', async () => {
          await group(domain, 'Raw');
          expect((await legacyRead(domain, 'Raw')).statusCode).toBe(200);
          const foreign = {
            authorization: `Bearer ${jwt.sign(
              { userId: randomUUID(), sessionId },
              f!.env.JWT_SECRET,
              { expiresIn: '1h' },
            )}`,
          };
          expect((await read(domain, 'Raw', foreign)).statusCode).toBe(401);
          await f!.pools.primaryPool.query(
            "UPDATE sessions SET status='REVOKED' WHERE id=$1",
            [sessionId],
          );
          expect([401, 403]).toContain((await read(domain, 'Raw')).statusCode);
        });
        it('keeps current path pure-space rejection and rejects invalid raw query IDs without shortening a valid target', async () => {
          expect((await legacyRead(domain, ' ')).statusCode).toBe(400);
          await group(domain, 'Raw');
          for (const id of [
            '',
            '\u0000',
            '\u0085',
            '\u009f',
            '\u007f',
            '🔎'.repeat(51),
          ])
            expect((await read(domain, id)).statusCode).toBe(400);
          expect((await read(domain, 'missing')).statusCode).toBe(404);
          expect((await read(domain, 'Raw')).json().data.id).toBe('Raw');
        });
        it('uses the selected domain database when both private databases contain the same raw ID', async () => {
          await group('primary', 'Raw', 'Primary target');
          await group('competitor', 'Raw', 'Competitor target');
          await child('primary', 'primary-child', 'Raw');
          await child('competitor', 'competitor-child', 'Raw');
          const response = await read(domain, 'Raw');
          expect(response.statusCode).toBe(200);
          expect(response.json().data.name).toBe(
            domain === 'primary' ? 'Primary target' : 'Competitor target',
          );
          expect(
            response.json().data.children.map((row: { id: string }) => row.id),
          ).toEqual([
            domain === 'primary' ? 'primary-child' : 'competitor-child',
          ]);
        });
        it('fails when the selected private domain table is unavailable and recovers after it is restored', async () => {
          await group(domain, 'Raw');
          await group(
            domain === 'primary' ? 'competitor' : 'primary',
            'Raw',
            'Wrong fallback',
          );
          const table = groups(domain);
          await db(domain).query(
            `ALTER TABLE ${table} RENAME TO hidden_literal_groups`,
          );
          try {
            expect((await read(domain, 'Raw')).statusCode).toBe(500);
          } finally {
            await db(domain).query(
              `ALTER TABLE hidden_literal_groups RENAME TO ${table}`,
            );
          }
          expect((await read(domain, 'Raw')).json().data.name).toBe(
            'Original literal target',
          );
        });
      },
    );
  },
);
