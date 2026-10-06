import {
  buildScheduledMonitorJobId,
  type ScheduledMonitorPlan,
} from '@asin-monitor/contracts';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPgPool } from '../src/client';
import {
  scheduledMonitorJobDigest,
  scheduledMonitorTaskId,
} from '../src/domain/scheduled-monitor-policy';

// Explicit fixture opt-in; never load deployment .env files or infer a live target.
const enabled = process.env.RUN_NEO_SCHEDULED_MONITOR_INTEGRATION === '1';
const suite = enabled ? describe : describe.skip;
const databases = new Map<string, string>();
const domains = [
  { domain: 'primary' as const, env: 'DATABASE_URL' },
  { domain: 'competitor' as const, env: 'COMPETITOR_DATABASE_URL' },
];
suite.each(domains)(
  '$domain scheduled ledger real PostgreSQL boundary',
  ({ domain, env }) => {
    const prefix = `${domain}_scheduled_monitor`;
    const schema = `neo_scheduled_${domain}_${process.pid}_${randomUUID()
      .replaceAll('-', '')
      .slice(0, 8)}`;
    if (!/^neo_scheduled_(primary|competitor)_\d+_[a-f0-9]{8}$/.test(schema))
      throw new Error('Invalid scheduled fixture schema');
    const qualified = `"${schema}"`;
    let pool: ReturnType<typeof createPgPool> | undefined;
    let client: PoolClient | undefined;
    let created = false;
    const connection = () => {
      if (!client) throw new Error('Scheduled ledger fixture is not connected');
      return client;
    };
    const sqlFile = (suffix: string) =>
      readFileSync(
        resolve(
          __dirname,
          `../migrations/0016_scheduled_monitor_${domain}${suffix}.sql`,
        ),
        'utf8',
      ).replaceAll('public.', `${qualified}.`);
    const plan: ScheduledMonitorPlan = {
      domain,
      country: 'US',
      plannedSlot: '2026-10-03T12:30:00.000Z',
      intervalMinutes: 30,
      batchConfig: { batchIndex: 0, totalBatches: 1 },
    };
    const job = {
      ...plan,
      version: 1 as const,
      source: 'scheduled' as const,
      taskType: 'scheduled-monitor' as const,
      actor: { kind: 'system' as const, purpose: 'scheduled-monitor' as const },
      taskId: scheduledMonitorTaskId(plan),
      jobId: buildScheduledMonitorJobId(plan),
      requestedAt: '2026-10-03T12:30:01.000Z',
      createdAt: '2026-10-03T12:30:02.000Z',
      expiresAt: '2026-10-10T12:30:02.000Z',
    };
    const digest = scheduledMonitorJobDigest(job);
    const run = (change: Record<string, unknown> = {}) => ({
      task_id: job.taskId,
      job_id: job.jobId,
      job_digest: digest,
      job: JSON.stringify(job),
      domain,
      country: 'US',
      planned_slot: job.plannedSlot,
      requested_at: job.requestedAt,
      created_at: job.createdAt,
      expires_at: job.expiresAt,
      interval_minutes: 30,
      batch_index: 0,
      total_batches: 1,
      groups: '[]',
      snapshot_digest: 'a'.repeat(64),
      total_members: 0,
      ...change,
    });
    const insert = (table: string, row: Record<string, unknown>) =>
      connection().query(
        `INSERT INTO ${prefix}_${table} (${Object.keys(row).join(
          ',',
        )}) VALUES (${Object.keys(row)
          .map((_, index) => `$${index + 1}`)
          .join(',')})`,
        Object.values(row),
      );
    const notice = (change: Record<string, unknown> = {}) => ({
      task_id: job.taskId,
      job_digest: digest,
      country: 'US',
      ...change,
    });
    const receipt = (change: Record<string, unknown> = {}) => ({
      ...notice(),
      operation_key: 'b'.repeat(64),
      request_hash: 'c'.repeat(64),
      group_id: ' raw\n组 ',
      ordinal: 0,
      snapshot_digest: 'd'.repeat(64),
      result_kind: domain === 'primary' ? 'group' : 'competitor-group',
      result: '{}',
      ...change,
    });
    const transaction = async (action: () => Promise<void>) => {
      await connection().query('BEGIN');
      try {
        await action();
      } finally {
        await connection().query('ROLLBACK');
      }
    };
    const reject = async (action: () => Promise<unknown>, code: string) => {
      await connection().query('SAVEPOINT invalid_boundary');
      try {
        await expect(action()).rejects.toMatchObject({ code });
      } finally {
        await connection().query('ROLLBACK TO SAVEPOINT invalid_boundary');
        await connection().query('RELEASE SAVEPOINT invalid_boundary');
      }
    };
    beforeAll(async () => {
      const url = process.env[env];
      if (!url) throw new Error(`Scheduled fixture requires ${env}`);
      pool = createPgPool(url, {
        max: 1,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 1000,
      });
      client = await pool.connect();
      const database = await client.query<{ name: string }>(
        'SELECT current_database() AS name',
      );
      databases.set(domain, database.rows[0].name);
      if (databases.size === 2)
        expect(databases.get('primary')).not.toBe(databases.get('competitor'));
      await client.query(`CREATE SCHEMA ${qualified}`);
      created = true;
      await client.query(
        `CREATE TABLE ${qualified}.${
          domain === 'primary' ? 'variant_groups' : 'competitor_variant_groups'
        } (id text PRIMARY KEY); CREATE TABLE ${qualified}.${
          domain === 'primary'
            ? 'monitor_history'
            : 'competitor_monitor_history'
        } (id integer PRIMARY KEY); CREATE TABLE ${qualified}.${domain}_monitor_runs (task_id text PRIMARY KEY,user_id text NOT NULL); CREATE TABLE ${qualified}.history_sentinel (id integer PRIMARY KEY); INSERT INTO ${qualified}.history_sentinel VALUES (1)`,
      );
      await client.query(sqlFile(''));
      await client.query(sqlFile(''));
      await client.query(`SET search_path TO ${qualified},pg_catalog`);
    });
    afterAll(async () => {
      try {
        if (created && client) {
          // A migration error may leave BEGIN aborted. Release that transaction
          // before removing only the fixture's schema, including setup failures.
          await client.query('ROLLBACK');
          await client.query(`DROP SCHEMA ${qualified} CASCADE`);
        }
      } finally {
        client?.release();
        await pool?.end();
      }
    });
    it('repeats upgrade with existing private records, repeats rollback, reapplies and preserves history/manual owner columns', async () => {
      await insert('runs', run());
      await connection().query(sqlFile(''));
      expect(
        (
          await connection().query(
            `SELECT count(*)::integer AS n FROM ${prefix}_runs`,
          )
        ).rows[0].n,
      ).toBe(1);
      await connection().query(sqlFile('.rollback'));
      await connection().query(sqlFile('.rollback'));
      await connection().query(sqlFile(''));
      await connection().query(sqlFile(''));
      expect(
        (
          await connection().query(
            'SELECT count(*)::integer AS n FROM history_sentinel',
          )
        ).rows[0].n,
      ).toBe(1);
      const columns = await connection().query<{ column_name: string }>(
        'SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY column_name',
        [schema, `${domain}_monitor_runs`],
      );
      expect(columns.rows.map((row) => row.column_name)).toEqual([
        'task_id',
        'user_id',
      ]);
    });
    it('stores the canonical complete system incarnation without borrowing a user/session', () =>
      transaction(async () => {
        await insert('runs', run());
        const result = await connection().query(
          `SELECT job,job_digest,actor_kind,actor_purpose,country FROM ${prefix}_runs`,
        );
        expect(result.rows[0]).toEqual({
          job,
          job_digest: digest,
          actor_kind: 'system',
          actor_purpose: 'scheduled-monitor',
          country: 'US',
        });
        const columns = await connection().query<{ column_name: string }>(
          'SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name LIKE $2',
          [schema, `${prefix}_%`],
        );
        expect(columns.rows.map((row) => row.column_name)).not.toContain(
          'user_id',
        );
        expect(columns.rows.map((row) => row.column_name)).not.toContain(
          'session_id',
        );
      }));
    it.each([
      `COMMENT ON TABLE ${prefix}_runs IS NULL`,
      `ALTER TABLE ${prefix}_runs ADD COLUMN unexpected text`,
      `ALTER TABLE ${prefix}_runs ALTER COLUMN job_digest TYPE varchar(65)`,
      `ALTER TABLE ${prefix}_runs ALTER COLUMN state SET DEFAULT 'running'`,
      `ALTER TABLE ${prefix}_runs DROP CONSTRAINT ck_${prefix}_batch`,
      `ALTER TABLE ${prefix}_runs DROP CONSTRAINT ck_${prefix}_digest; ALTER TABLE ${prefix}_runs ADD CONSTRAINT ck_${prefix}_digest CHECK (true)`,
      `ALTER TABLE ${prefix}_runs ENABLE ROW LEVEL SECURITY`,
      `ALTER TABLE ${prefix}_runs DISABLE TRIGGER ALL`,
      `DROP INDEX idx_${prefix}_expiry`,
      `DROP TABLE ${prefix}_runs CASCADE; CREATE TABLE index_owner(id integer); CREATE INDEX idx_${prefix}_expiry ON index_owner(id)`,
      `ALTER TABLE ${prefix}_notifications DROP CONSTRAINT fk_${prefix}_notice_run`,
    ])(
      'refuses catalog drift before a repeated upgrade can repair it (%#)',
      async (alter) => {
        await connection().query('BEGIN');
        try {
          await connection().query(alter);
          await expect(connection().query(sqlFile(''))).rejects.toMatchObject({
            code: 'P0001',
          });
        } finally {
          // A failed migration aborts the transaction; restoring its original
          // schema lets later cases test independently without patching markers.
          await connection().query('ROLLBACK');
        }
        await connection().query(sqlFile(''));
        expect(
          (
            await connection().query(
              'SELECT count(*)::integer AS n FROM history_sentinel',
            )
          ).rows[0].n,
        ).toBe(1);
      },
    );
    it('rejects borrowed actors, mixed-domain payloads, raw user identity and invalid job digests', () =>
      transaction(async () => {
        for (const change of [
          { actor_kind: 'user' },
          { actor_purpose: 'manual-monitor' },
          { domain: domain === 'primary' ? 'competitor' : 'primary' },
          { job: JSON.stringify({ ...job, userId: 'borrowed-user' }) },
          { job: JSON.stringify({ ...job, country: 'DE' }) },
          {
            job: JSON.stringify({
              ...job,
              expiresAt: '2026-10-11T12:30:02.000Z',
            }),
          },
          { job_digest: 'unknown' },
        ])
          await reject(() => insert('runs', run(change)), '23514');
      }));
    it('rejects missing and JSON-null required identity/time keys instead of passing SQL UNKNOWN', () =>
      transaction(async () => {
        for (const key of [
          'version',
          'source',
          'taskType',
          'actor',
          'domain',
          'country',
          'taskId',
          'jobId',
          'intervalMinutes',
          'batchConfig',
          'plannedSlot',
          'requestedAt',
          'createdAt',
          'expiresAt',
        ]) {
          const missing: Record<string, unknown> = { ...job };
          delete missing[key];
          for (const value of [missing, { ...job, [key]: null }])
            await reject(
              () => insert('runs', run({ job: JSON.stringify(value) })),
              '23514',
            );
        }
        for (const value of [
          null,
          { ...job, actor: { kind: 'system' } },
          { ...job, actor: { purpose: 'scheduled-monitor' } },
          { ...job, actor: { kind: null, purpose: 'scheduled-monitor' } },
          { ...job, batchConfig: { batchIndex: 0 } },
          { ...job, batchConfig: { totalBatches: 1 } },
          { ...job, batchConfig: { batchIndex: null, totalBatches: 1 } },
        ])
          await reject(
            () => insert('runs', run({ job: JSON.stringify(value) })),
            '23514',
          );
      }));
    it('refuses the opposite domain upgrade before creating any mixed-ledger table', async () => {
      const opposite = domain === 'primary' ? 'competitor' : 'primary';
      const oppositeSql = readFileSync(
        resolve(
          __dirname,
          `../migrations/0016_scheduled_monitor_${opposite}.sql`,
        ),
        'utf8',
      ).replaceAll('public.', `${qualified}.`);
      try {
        await expect(connection().query(oppositeSql)).rejects.toMatchObject({
          code: 'P0001',
        });
      } finally {
        await connection().query('ROLLBACK');
      }
      expect(
        (
          await connection().query(
            'SELECT count(*)::integer AS n FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE $2',
            [schema, `${opposite}_scheduled_monitor_%`],
          )
        ).rows[0].n,
      ).toBe(0);
    });
    it('rejects stale-plan replacements and capacities before any receipt or notice exists', () =>
      transaction(async () => {
        for (const change of [
          { planned_slot: '2026-10-03T12:30:00.000001Z' },
          { requested_at: '2026-10-03T12:29:59.999Z' },
          { expires_at: job.createdAt },
          { batch_index: 1 },
          { total_batches: 1001 },
          { interval_minutes: 10 },
          { total_members: 20001 },
          { groups: JSON.stringify(Array.from({ length: 1001 }, () => ({}))) },
        ])
          await reject(() => insert('runs', run(change)), '23514');
        expect(
          (
            await connection().query(
              `SELECT count(*)::integer AS n FROM ${prefix}_group_receipts`,
            )
          ).rows[0].n,
        ).toBe(0);
        expect(
          (
            await connection().query(
              `SELECT count(*)::integer AS n FROM ${prefix}_notifications`,
            )
          ).rows[0].n,
        ).toBe(0);
      }));
    it('requires durable completion and a complete US-only follow-up receipt tuple', () =>
      transaction(async () => {
        await reject(
          () => insert('runs', run({ state: 'completed' })),
          '23514',
        );
        await reject(
          () => insert('runs', run({ state: 'business-completed' })),
          '23514',
        );
        await reject(
          () =>
            insert(
              'runs',
              run({
                state: 'skipped-expired',
                completed_at: '2026-10-03T12:35:00.000Z',
                business_completed_at: '2026-10-03T12:34:00.000Z',
              }),
            ),
          '23514',
        );
        const childPlan = { ...plan, domain: 'competitor' as const };
        const child = {
          ...job,
          ...childPlan,
          taskId: scheduledMonitorTaskId(childPlan),
          jobId: buildScheduledMonitorJobId(childPlan),
          requestedAt: '2026-10-03T12:35:00.000Z',
          createdAt: '2026-10-03T12:35:00.000Z',
        };
        const completed = {
          state: 'business-completed',
          business_completed_at: '2026-10-03T12:34:00.000Z',
          follow_up_job: JSON.stringify(child),
          follow_up_digest: scheduledMonitorJobDigest(child),
        };
        await reject(() => insert('runs', run(completed)), '23514');
        if (domain === 'competitor')
          await reject(
            () =>
              insert(
                'runs',
                run({
                  ...completed,
                  follow_up_requested_at: child.requestedAt,
                }),
              ),
            '23514',
          );
        else {
          await insert(
            'runs',
            run({ ...completed, follow_up_requested_at: child.requestedAt }),
          );
          expect(
            (
              await connection().query(
                `SELECT follow_up_job FROM ${prefix}_runs`,
              )
            ).rows[0].follow_up_job,
          ).toEqual(child);
        }
      }));
    it('binds notification claims to the original digest/country and preserves unknown sends as claimed', () =>
      transaction(async () => {
        await insert('runs', run());
        await reject(
          () => insert('notifications', notice({ job_digest: 'f'.repeat(64) })),
          '23503',
        );
        await reject(
          () => insert('notifications', notice({ country: 'DE' })),
          '23503',
        );
        await reject(
          () => insert('notifications', notice({ state: 'sent' })),
          '23514',
        );
        await insert('notifications', notice());
        await reject(() => insert('notifications', notice()), '23505');
        expect(
          (
            await connection().query(
              `SELECT state,completed_at FROM ${prefix}_notifications`,
            )
          ).rows[0],
        ).toEqual({ state: 'claimed', completed_at: null });
      }));
    it('protects raw group IDs, original snapshot/ordinal and domain-specific result receipts', () =>
      transaction(async () => {
        await insert('runs', run());
        await reject(
          () =>
            insert('group_receipts', receipt({ job_digest: 'f'.repeat(64) })),
          '23503',
        );
        await reject(
          () => insert('group_receipts', receipt({ ordinal: 1000 })),
          '23514',
        );
        await reject(
          () =>
            insert(
              'group_receipts',
              receipt({
                result_kind:
                  domain === 'primary' ? 'competitor-group' : 'group',
              }),
            ),
          '23514',
        );
        await insert('group_receipts', receipt());
        await reject(
          () =>
            insert(
              'group_receipts',
              receipt({ operation_key: 'e'.repeat(64), group_id: 'another' }),
            ),
          '23505',
        );
        await reject(
          () =>
            insert(
              'group_receipts',
              receipt({ operation_key: 'e'.repeat(64), ordinal: 1 }),
            ),
          '23505',
        );
        expect(
          (
            await connection().query(
              `SELECT group_id,ordinal,snapshot_digest FROM ${prefix}_group_receipts`,
            )
          ).rows[0],
        ).toEqual({
          group_id: ' raw\n组 ',
          ordinal: 0,
          snapshot_digest: 'd'.repeat(64),
        });
      }));
    it('purges only private children through the owned run, leaving business history intact', () =>
      transaction(async () => {
        await insert('runs', run());
        await insert('notifications', notice());
        await insert('group_receipts', receipt());
        await connection().query(
          `DELETE FROM ${prefix}_runs WHERE task_id=$1 AND job_digest=$2`,
          [job.taskId, digest],
        );
        expect(
          (
            await connection().query(
              `SELECT (SELECT count(*)::integer FROM ${prefix}_notifications) AS notices,(SELECT count(*)::integer FROM ${prefix}_group_receipts) AS receipts`,
            )
          ).rows[0],
        ).toEqual({ notices: 0, receipts: 0 });
        expect(
          (
            await connection().query(
              'SELECT count(*)::integer AS n FROM history_sentinel',
            )
          ).rows[0].n,
        ).toBe(1);
      }));
  },
);
