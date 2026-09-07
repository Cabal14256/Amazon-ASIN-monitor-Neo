import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createPgPool,
  createShanghaiTimestampTypeOverrides,
} from '../src/client';
import { AuditQueryRepository } from '../src/repositories/audit-query-repository';
import { PgAuthMaintenanceRepository } from '../src/repositories/auth-maintenance-repository';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'Authentication maintenance on real PostgreSQL',
  () => {
    const schema = `auth_maintenance_65_${randomUUID().replace(/-/g, '')}`;
    const now = new Date('2026-09-07T00:00:00Z');
    let bootstrap: Pool;
    let pool: Pool;
    let repo: PgAuthMaintenanceRepository;
    let queries: AuditQueryRepository;
    let installed = false;
    let nextId = 1000;
    const migration = (rollback = false) =>
      readFileSync(
        resolve(
          __dirname,
          `../migrations/0003_auth_maintenance${
            rollback ? '.rollback' : ''
          }.sql`,
        ),
        'utf8',
      ).replaceAll('public', schema);
    beforeAll(async () => {
      if (!/^auth_maintenance_65_[0-9a-f]{32}$/.test(schema))
        throw new Error('Invalid fixture schema');
      bootstrap = createPgPool(process.env.DATABASE_URL!, {
        max: 2,
        connectionTimeoutMillis: 2000,
      });
      await bootstrap.query(`CREATE SCHEMA ${schema}`);
      installed = true;
      for (const table of ['users', 'sessions', 'audit_logs'])
        await bootstrap.query(
          `CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`,
        );
      await bootstrap.query(
        `ALTER TABLE ${schema}.sessions ADD FOREIGN KEY (user_id) REFERENCES ${schema}.users(id) ON DELETE CASCADE`,
      );
      const url = new URL(process.env.DATABASE_URL!);
      url.searchParams.set(
        'options',
        `-c search_path=${schema},public -c timezone=UTC`,
      );
      pool = createPgPool(url.toString(), {
        max: 6,
        connectionTimeoutMillis: 2000,
        types: createShanghaiTimestampTypeOverrides(),
      });
      await apply(false);
      await apply(false);
      expect(
        (await pool.query('SELECT current_schema() AS schema')).rows[0].schema,
      ).toBe(schema);
      repo = new PgAuthMaintenanceRepository(pool);
      queries = new AuditQueryRepository(pool);
    });
    afterAll(async () => {
      try {
        if (pool) await pool.end();
      } finally {
        if (bootstrap) {
          try {
            if (installed)
              await bootstrap.query(`DROP SCHEMA ${schema} CASCADE`);
          } finally {
            await bootstrap.end();
          }
        }
      }
    });
    async function apply(rollback: boolean) {
      const connection = await pool.connect();
      try {
        await connection.query(migration(rollback));
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      } finally {
        await connection.query(`SET search_path TO ${schema}, public`);
        connection.release();
      }
    }
    beforeEach(async () => {
      await apply(false);
      await pool.query(
        'TRUNCATE audit_logs, audit_logs_archive, sessions, users CASCADE',
      );
    });
    async function audit(
      createTime: string | null,
      overrides: {
        id?: string;
        action?: string;
        resource?: string | null;
      } = {},
    ) {
      const id = overrides.id ?? String(++nextId);
      await pool.query(
        `INSERT INTO audit_logs (id,user_id,username,action,resource,resource_id,resource_name,method,path,ip_address,user_agent,request_data,response_status,error_message,create_time)
      OVERRIDING SYSTEM VALUE VALUES($1,'fixture-user','测试用户',$2,$3,'fixture-resource','测试资源','PUT','/fixture','192.0.2.1','fixture-agent','{"nested":{"ok":true}}',200,NULL,$4)`,
        [
          id,
          overrides.action ?? 'UPDATE',
          overrides.resource === undefined ? 'user' : overrides.resource,
          createTime,
        ],
      );
      return id;
    }
    const rows = async (
      table: 'audit_logs' | 'audit_logs_archive' | 'audit_logs_all',
    ) =>
      (
        await pool.query(
          `SELECT row_to_json(t)::text AS record FROM ${table} t ORDER BY id`,
        )
      ).rows.map((row) => row.record);
    async function drainArchive(limit = 1000) {
      for (let i = 0; i < 20; i++) {
        const batch = await repo.archiveAuditLogs(90, limit, now);
        if (!batch.hasMore) return;
      }
      throw new Error('Fixture archive did not drain');
    }
    it('cleans only expired non-NULL sessions, bounds each batch and skips locked rows without changing users', async () => {
      await pool.query(
        "INSERT INTO users(id,username,password) VALUES('fixture-owner','fixture-owner','fixture-unused-hash')",
      );
      for (const [id, expiry, status] of [
        ['locked', '2026-01-01 08:00:00', 'ACTIVE'],
        ['older', '2026-06-01 08:00:00', 'REVOKED'],
        ['boundary', '2026-09-07 08:00:00', 'ACTIVE'],
        ['future', '2026-09-07 08:00:00.001', 'ACTIVE'],
        ['unbounded', null, 'REVOKED'],
      ])
        await pool.query(
          'INSERT INTO sessions(id,user_id,expires_at,status) VALUES($1,$2,$3,$4)',
          [id, 'fixture-owner', expiry, status],
        );
      const connection = await pool.connect();
      await connection.query('BEGIN');
      await connection.query(
        "SELECT id FROM sessions WHERE id='locked' FOR UPDATE",
      );
      try {
        expect(await repo.cleanupSessions(2, now)).toEqual({
          processed: 2,
          hasMore: true,
          busy: false,
        });
      } finally {
        await connection.query('ROLLBACK');
        connection.release();
      }
      expect(await repo.cleanupSessions(2, now)).toEqual({
        processed: 1,
        hasMore: false,
        busy: false,
      });
      expect(
        (await pool.query('SELECT id FROM sessions ORDER BY id')).rows.map(
          (row) => row.id,
        ),
      ).toEqual(['future', 'unbounded']);
      expect((await pool.query('SELECT id FROM users')).rows).toEqual([
        { id: 'fixture-owner' },
      ]);
    });
    it('moves monthly batches losslessly and preserves all four audit query results at the 90-day Beijing boundary', async () => {
      const first = await audit('2026-05-01 08:00:00');
      await audit('2026-06-08 08:00:00', {
        action: 'update',
        resource: 'USER',
      });
      await audit('2026-06-09 07:59:59.999999', { resource: null });
      await audit('2026-06-09 08:00:00');
      await audit('2026-09-07 08:00:00');
      await audit(null);
      const snapshot = async () => ({
        list: await queries.list({ current: 1, pageSize: 50 }),
        detail: await queries.detail(Number(first)),
        actions: await queries.actions({}),
        resources: await queries.resources({}),
      });
      const before = await snapshot();
      const all = await rows('audit_logs');
      expect(await repo.archiveAuditLogs(90, 2, now)).toEqual({
        processed: 1,
        hasMore: true,
        busy: false,
      });
      expect(await repo.archiveAuditLogs(90, 2, now)).toEqual({
        processed: 2,
        hasMore: false,
        busy: false,
      });
      expect(await rows('audit_logs_all')).toEqual(all);
      expect(await snapshot()).toEqual(before);
      expect(await rows('audit_logs_archive')).toHaveLength(3);
      expect(await rows('audit_logs')).toHaveLength(3);
      const partitions = (
        await pool.query(
          "SELECT child.relname FROM pg_inherits i JOIN pg_class child ON child.oid=i.inhrelid WHERE i.inhparent='audit_logs_archive'::regclass ORDER BY child.relname",
        )
      ).rows;
      expect(partitions).toEqual([
        { relname: 'audit_logs_archive_2026_05' },
        { relname: 'audit_logs_archive_2026_06' },
      ]);
    });
    it('rolls back the entire move and newly created partition if archive insertion fails', async () => {
      await audit('2024-01-01 08:00:00');
      const before = await rows('audit_logs');
      await pool.query(
        "CREATE FUNCTION reject_archive_65() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture-archive-insert-failure'; END $$",
      );
      await pool.query(
        'CREATE TRIGGER reject_archive_65 AFTER INSERT ON audit_logs_archive FOR EACH ROW EXECUTE FUNCTION reject_archive_65()',
      );
      try {
        await expect(repo.archiveAuditLogs(90, 1000, now)).rejects.toThrow();
      } finally {
        await pool.query(
          'DROP TRIGGER reject_archive_65 ON audit_logs_archive',
        );
        await pool.query('DROP FUNCTION reject_archive_65()');
      }
      expect(await rows('audit_logs')).toEqual(before);
      expect(await rows('audit_logs_archive')).toEqual([]);
      expect(
        (
          await pool.query(
            "SELECT to_regclass('audit_logs_archive_2024_01') AS name",
          )
        ).rows[0].name,
      ).toBeNull();
      expect((await repo.archiveAuditLogs(90, 1000, now)).processed).toBe(1);
    });
    it('returns busy without touching data when another maintainer owns the transaction lock', async () => {
      await audit('2026-05-01 08:00:00');
      const connection = await pool.connect();
      await connection.query('BEGIN');
      await connection.query('SELECT pg_advisory_xact_lock(1095977295,2)');
      try {
        expect(await repo.archiveAuditLogs(90, 1000, now)).toEqual({
          processed: 0,
          hasMore: true,
          busy: true,
        });
      } finally {
        await connection.query('ROLLBACK');
        connection.release();
      }
      expect(await rows('audit_logs_archive')).toEqual([]);
      expect((await repo.archiveAuditLogs(90, 1000, now)).processed).toBe(1);
    });
    it('concurrent maintainers and retries never duplicate or lose an audit record', async () => {
      for (let i = 0; i < 5; i++) await audit('2026-05-01 08:00:00');
      const before = await rows('audit_logs');
      await Promise.all([
        repo.archiveAuditLogs(90, 2, now),
        new PgAuthMaintenanceRepository(pool).archiveAuditLogs(90, 2, now),
      ]);
      await drainArchive(2);
      expect(await rows('audit_logs_archive')).toEqual(before);
      expect(await repo.archiveAuditLogs(90, 2, now)).toEqual({
        processed: 0,
        hasMore: false,
        busy: false,
      });
    });
    it('a repeatable read audit snapshot sees one copy while another connection commits the move', async () => {
      // These months have no pre-existing partitions: ATTACH must also remain
      // compatible with the long-running reader of the archive parent.
      await audit('2023-03-01 08:00:00');
      await audit('2023-04-01 08:00:00');
      const connection = await pool.connect();
      await connection.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const before = await connection.query(
          'SELECT id::text FROM audit_logs_all ORDER BY id',
        );
        await drainArchive();
        expect(
          (
            await connection.query(
              'SELECT id::text FROM audit_logs_all ORDER BY id',
            )
          ).rows,
        ).toEqual(before.rows);
      } finally {
        await connection.query('ROLLBACK');
        connection.release();
      }
      expect(await rows('audit_logs')).toEqual([]);
      expect(await rows('audit_logs_all')).toHaveLength(2);
    });
    it('refuses out-of-band duplicate archive IDs even when their months differ', async () => {
      const id = await audit('2026-05-01 08:00:00');
      await drainArchive();
      await audit('2026-06-01 08:00:00', { id });
      const before = {
        hot: await rows('audit_logs'),
        cold: await rows('audit_logs_archive'),
      };
      await expect(repo.archiveAuditLogs(90, 1000, now)).rejects.toThrow(
        'Audit archive identity conflict',
      );
      expect({
        hot: await rows('audit_logs'),
        cold: await rows('audit_logs_archive'),
      }).toEqual(before);
    });
    it('rollback restores every field and unsafe-bigint ID and never lowers the identity sequence', async () => {
      await audit('2026-05-01 08:00:00', { id: '9007199254741023' });
      const before = await rows('audit_logs');
      await drainArchive();
      await expect(
        queries.list({ current: 1, pageSize: 10 }),
      ).rejects.toThrow();
      await apply(true);
      expect(await rows('audit_logs')).toEqual(before);
      const inserted = await pool.query(
        "INSERT INTO audit_logs(action) VALUES('FIXTURE') RETURNING id::text",
      );
      expect(BigInt(inserted.rows[0].id)).toBeGreaterThan(9007199254741023n);
      await apply(false);
    });
    it('rollback refuses conflicting hot data without dropping or changing archived evidence', async () => {
      const id = await audit('2026-05-01 08:00:00');
      await drainArchive();
      await audit('2026-05-01 08:00:00', { id, action: 'DIFFERENT' });
      const before = {
        hot: await rows('audit_logs'),
        cold: await rows('audit_logs_archive'),
      };
      await expect(apply(true)).rejects.toThrow(
        'Audit archive rollback conflict',
      );
      expect({
        hot: await rows('audit_logs'),
        cold: await rows('audit_logs_archive'),
      }).toEqual(before);
    });
    it('a blocked archive query times out without late moves and succeeds after recovery', async () => {
      await audit('2026-05-01 08:00:00');
      const before = await rows('audit_logs');
      const connection = await pool.connect();
      await connection.query('BEGIN');
      await connection.query(
        'LOCK TABLE audit_logs_archive IN ACCESS EXCLUSIVE MODE',
      );
      try {
        await expect(repo.archiveAuditLogs(90, 1000, now)).rejects.toThrow();
      } finally {
        await connection.query('ROLLBACK');
        connection.release();
      }
      expect(await rows('audit_logs')).toEqual(before);
      expect(await rows('audit_logs_archive')).toEqual([]);
      expect((await repo.archiveAuditLogs(90, 1000, now)).processed).toBe(1);
    });
  },
);
