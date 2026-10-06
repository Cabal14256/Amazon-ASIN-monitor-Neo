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
  parseScheduledMonitorJob,
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
    const oldV1Sql = () =>
      readFileSync(
        resolve(__dirname, `fixtures/scheduled-monitor-v1-${domain}.sql`),
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
    const childPlan = { ...plan, domain: 'competitor' as const };
    const child = {
      ...job,
      ...childPlan,
      taskId: scheduledMonitorTaskId(childPlan),
      jobId: buildScheduledMonitorJobId(childPlan),
      requestedAt: '2026-10-03T12:34:00.000Z',
      createdAt: '2026-10-03T12:34:00.000Z',
    };
    const business = (value: unknown = child) => ({
      state: 'business-completed',
      business_completed_at: child.createdAt,
      follow_up_job: JSON.stringify(value),
      follow_up_digest: scheduledMonitorJobDigest(child),
      follow_up_requested_at: child.requestedAt,
    });
    const ledgerCatalog = async () =>
      (
        await connection().query(
          `SELECT c.relname,obj_description(c.oid,'pg_class') AS marker,
       (SELECT jsonb_agg(jsonb_build_array(k.conname,k.convalidated,pg_get_constraintdef(k.oid)) ORDER BY k.conname) FROM pg_constraint k WHERE k.conrelid=c.oid) AS constraints
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=ANY($2::text[]) ORDER BY c.relname`,
          [
            schema,
            [
              `${prefix}_runs`,
              `${prefix}_notifications`,
              `${prefix}_group_receipts`,
            ],
          ],
        )
      ).rows;
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
    const rejectMigration = async (migration: string) => {
      try {
        await expect(connection().query(migration)).rejects.toMatchObject({
          code: 'P0001',
        });
      } finally {
        await connection().query('ROLLBACK');
      }
    };
    const ledgerNames = [
      `${prefix}_runs`,
      `${prefix}_notifications`,
      `${prefix}_group_receipts`,
    ];
    const presentLedgers = async () =>
      (
        await connection().query<{ table_name: string }>(
          'SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name=ANY($2::text[]) ORDER BY table_name',
          [schema, ledgerNames],
        )
      ).rows.map((row) => row.table_name);
    beforeAll(async () => {
      const url = process.env[env];
      if (!url) throw new Error(`Scheduled fixture requires ${env}`);
      pool = createPgPool(url, {
        max: 3,
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
    it.each(ledgerNames)(
      'preserves foreign %s and its data after both upgrade and rollback refuse an unmarked collision',
      async (table) => {
        await connection().query(sqlFile('.rollback'));
        try {
          await connection().query(
            `CREATE TABLE ${qualified}.${table}(sentinel text PRIMARY KEY); INSERT INTO ${qualified}.${table} VALUES ('foreign-data')`,
          );
          await rejectMigration(sqlFile(''));
          await rejectMigration(sqlFile('.rollback'));
          expect(await presentLedgers()).toEqual([table]);
          expect(
            (
              await connection().query(
                `SELECT sentinel FROM ${qualified}.${table}`,
              )
            ).rows,
          ).toEqual([{ sentinel: 'foreign-data' }]);
        } finally {
          await connection().query('ROLLBACK');
          await connection().query(
            `DROP TABLE IF EXISTS ${qualified}.${table}`,
          );
          await connection().query(sqlFile(''));
        }
      },
    );
    it('validates every child before dropping any owned sibling or parent', async () => {
      const child = `${prefix}_notifications`;
      await insert('runs', run());
      try {
        await connection().query(
          `DROP TABLE ${qualified}.${child}; CREATE TABLE ${qualified}.${child}(sentinel text PRIMARY KEY); INSERT INTO ${qualified}.${child} VALUES ('foreign-child')`,
        );
        await rejectMigration(sqlFile('.rollback'));
        expect(await presentLedgers()).toEqual([...ledgerNames].sort());
        expect(
          (
            await connection().query(
              `SELECT task_id FROM ${qualified}.${prefix}_runs`,
            )
          ).rows,
        ).toEqual([{ task_id: job.taskId }]);
        expect(
          (
            await connection().query(
              `SELECT sentinel FROM ${qualified}.${child}`,
            )
          ).rows,
        ).toEqual([{ sentinel: 'foreign-child' }]);
      } finally {
        await connection().query('ROLLBACK');
        await connection().query(`DROP TABLE IF EXISTS ${qualified}.${child}`);
        await connection().query(sqlFile('.rollback'));
        await connection().query(sqlFile(''));
      }
    });
    it.each([
      {
        label: 'another domain',
        value: `amazon-asin-monitor:scheduled-ledger:v1:${
          domain === 'primary' ? 'competitor' : 'primary'
        }:${prefix}_runs:${'a'.repeat(32)}`,
      },
      {
        label: 'another table',
        value: `amazon-asin-monitor:scheduled-ledger:v1:${domain}:${prefix}_notifications:${'a'.repeat(
          32,
        )}`,
      },
      {
        label: 'another migration version',
        value: `amazon-asin-monitor:scheduled-ledger:v2:${domain}:${prefix}_runs:${'a'.repeat(
          32,
        )}`,
      },
      {
        label: 'malformed fingerprint',
        value: `amazon-asin-monitor:scheduled-ledger:v1:${domain}:${prefix}_runs:unknown`,
      },
    ])(
      'preserves all ledgers when a marker belongs to $label',
      async ({ value }) => {
        const table = `${qualified}.${prefix}_runs`;
        const marker = (
          await connection().query<{ marker: string }>(
            "SELECT obj_description($1::regclass,'pg_class') AS marker",
            [table],
          )
        ).rows[0].marker;
        await insert('runs', run());
        try {
          // All marker values above are test-owned constant strings.
          await connection().query(`COMMENT ON TABLE ${table} IS '${value}'`);
          await rejectMigration(sqlFile('.rollback'));
          expect(await presentLedgers()).toEqual([...ledgerNames].sort());
          expect(
            (await connection().query(`SELECT task_id FROM ${table}`)).rows,
          ).toEqual([{ task_id: job.taskId }]);
        } finally {
          await connection().query('ROLLBACK');
          await connection().query(`COMMENT ON TABLE ${table} IS '${marker}'`);
          await connection().query(sqlFile('.rollback'));
          await connection().query(sqlFile(''));
        }
      },
    );
    it('refuses a marked non-table relation before dropping any owned table', async () => {
      const child = `${prefix}_notifications`;
      await insert('runs', run());
      try {
        await connection().query(
          `DROP TABLE ${qualified}.${child}; CREATE VIEW ${qualified}.${child} AS SELECT 'foreign-view'::text AS sentinel; COMMENT ON VIEW ${qualified}.${child} IS 'amazon-asin-monitor:scheduled-ledger:v1:${domain}:${child}:${'a'.repeat(
            32,
          )}'`,
        );
        await rejectMigration(sqlFile('.rollback'));
        expect(
          (
            await connection().query(
              `SELECT task_id FROM ${qualified}.${prefix}_runs`,
            )
          ).rows,
        ).toEqual([{ task_id: job.taskId }]);
        expect(
          (
            await connection().query(
              `SELECT sentinel FROM ${qualified}.${child}`,
            )
          ).rows,
        ).toEqual([{ sentinel: 'foreign-view' }]);
      } finally {
        await connection().query('ROLLBACK');
        await connection().query(`DROP VIEW IF EXISTS ${qualified}.${child}`);
        await connection().query(sqlFile('.rollback'));
        await connection().query(sqlFile(''));
      }
    });
    it('rejects rollback on a wrong logical catalog and preserves every owned ledger', async () => {
      const opposite =
        domain === 'primary' ? 'competitor_variant_groups' : 'variant_groups';
      await insert('runs', run());
      try {
        await connection().query(
          `CREATE TABLE ${qualified}.${opposite}(id text)`,
        );
        await rejectMigration(sqlFile('.rollback'));
        expect(await presentLedgers()).toEqual([...ledgerNames].sort());
        expect(
          (
            await connection().query(
              `SELECT task_id FROM ${qualified}.${prefix}_runs`,
            )
          ).rows,
        ).toEqual([{ task_id: job.taskId }]);
      } finally {
        await connection().query('ROLLBACK');
        await connection().query(
          `DROP TABLE IF EXISTS ${qualified}.${opposite}`,
        );
        await connection().query(sqlFile('.rollback'));
        await connection().query(sqlFile(''));
      }
    });
    it.each([
      domain === 'primary' ? 'variant_groups' : 'competitor_variant_groups',
      domain === 'primary' ? 'monitor_history' : 'competitor_monitor_history',
      `${domain}_monitor_runs`,
    ])(
      'preserves present ledgers when logical prerequisite %s is missing',
      async (table) => {
        const renamed = `${table}_temporarily_missing`;
        await insert('runs', run());
        try {
          await connection().query(
            `ALTER TABLE ${qualified}.${table} RENAME TO ${renamed}`,
          );
          await rejectMigration(sqlFile('.rollback'));
          expect(await presentLedgers()).toEqual([...ledgerNames].sort());
          expect(
            (
              await connection().query(
                `SELECT task_id FROM ${qualified}.${prefix}_runs`,
              )
            ).rows,
          ).toEqual([{ task_id: job.taskId }]);
        } finally {
          await connection().query('ROLLBACK');
          await connection().query(
            `ALTER TABLE ${qualified}.${renamed} RENAME TO ${table}`,
          );
          await connection().query(sqlFile('.rollback'));
          await connection().query(sqlFile(''));
        }
      },
    );
    it.each([
      { label: 'one child', tables: [`${prefix}_notifications`] },
      {
        label: 'both children',
        tables: [`${prefix}_group_receipts`, `${prefix}_notifications`],
      },
      {
        label: 'the parent and its dependent constraints',
        tables: [`${prefix}_runs`],
      },
    ])(
      'cleans only the remaining owned tables after losing $label',
      async ({ tables }) => {
        try {
          for (const table of tables)
            await connection().query(
              `DROP TABLE ${qualified}.${table} CASCADE`,
            );
          await connection().query(sqlFile('.rollback'));
          await connection().query(sqlFile('.rollback'));
          expect(await presentLedgers()).toEqual([]);
          expect(
            (
              await connection().query(
                `SELECT id FROM ${qualified}.history_sentinel`,
              )
            ).rows,
          ).toEqual([{ id: 1 }]);
        } finally {
          await connection().query('ROLLBACK');
          await connection().query(sqlFile('.rollback'));
          await connection().query(sqlFile(''));
        }
      },
    );
    it('does nothing when no ledger exists even on an unrelated logical catalog', async () => {
      const opposite =
        domain === 'primary' ? 'competitor_variant_groups' : 'variant_groups';
      await connection().query(sqlFile('.rollback'));
      try {
        await connection().query(
          `CREATE TABLE ${qualified}.${opposite}(sentinel text); INSERT INTO ${qualified}.${opposite} VALUES ('unrelated-data')`,
        );
        await connection().query(sqlFile('.rollback'));
        await connection().query(sqlFile('.rollback'));
        expect(await presentLedgers()).toEqual([]);
        expect(
          (
            await connection().query(
              `SELECT sentinel FROM ${qualified}.${opposite}`,
            )
          ).rows,
        ).toEqual([{ sentinel: 'unrelated-data' }]);
      } finally {
        await connection().query('ROLLBACK');
        await connection().query(
          `DROP TABLE IF EXISTS ${qualified}.${opposite}`,
        );
        await connection().query(sqlFile(''));
      }
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
    it('tightens already owned historical v1 checks, preserves valid data and repeats with a stable new fingerprint', async () => {
      await connection().query(sqlFile('.rollback'));
      try {
        await connection().query(oldV1Sql());
        await insert('runs', run(domain === 'primary' ? business() : {}));
        const before = await ledgerCatalog();
        await connection().query(sqlFile(''));
        const after = await ledgerCatalog();
        expect(
          after.find((row) => row.relname === `${prefix}_runs`)?.marker,
        ).not.toBe(
          before.find((row) => row.relname === `${prefix}_runs`)?.marker,
        );
        const persisted = (
          await connection().query(
            `SELECT job,follow_up_job FROM ${prefix}_runs`,
          )
        ).rows[0];
        expect(parseScheduledMonitorJob(persisted.job)).toEqual(job);
        expect(persisted.follow_up_job).toEqual(
          domain === 'primary' ? child : null,
        );
        if (persisted.follow_up_job)
          expect(parseScheduledMonitorJob(persisted.follow_up_job)).toEqual(
            child,
          );
        await connection().query(sqlFile(''));
        expect(await ledgerCatalog()).toEqual(after);
      } finally {
        await connection().query('ROLLBACK');
        await connection().query(sqlFile('.rollback'));
        await connection().query(sqlFile(''));
      }
    });
    it.each([
      { label: 'root session', changes: { sessionId: 'borrowed-session' } },
      {
        label: 'nested actor user',
        changes: { actor: { ...job.actor, userId: 'borrowed-user' } },
      },
      {
        label: 'nested actor session',
        changes: { actor: { ...job.actor, sessionId: 'borrowed-session' } },
      },
    ])(
      'refuses tightening historical v1 polluted by $label and preserves its original constraints, marker and data',
      async ({ changes }) => {
        await connection().query(sqlFile('.rollback'));
        try {
          await connection().query(oldV1Sql());
          const polluted = { ...job, ...changes };
          await insert('runs', run({ job: JSON.stringify(polluted) }));
          const before = await ledgerCatalog();
          try {
            await expect(connection().query(sqlFile(''))).rejects.toMatchObject(
              { code: '23514' },
            );
          } finally {
            await connection().query('ROLLBACK');
          }
          expect(await ledgerCatalog()).toEqual(before);
          expect(
            (await connection().query(`SELECT job FROM ${prefix}_runs`)).rows,
          ).toEqual([{ job: polluted }]);
        } finally {
          await connection().query('ROLLBACK');
          await connection().query(sqlFile('.rollback'));
          await connection().query(sqlFile(''));
        }
      },
    );
    if (domain === 'primary')
      it.each(['taskId', 'jobId', 'createdAt', 'expiresAt'])(
        'refuses a historical v1 child missing %s and rolls back every new check/marker',
        async (field) => {
          await connection().query(sqlFile('.rollback'));
          try {
            await connection().query(oldV1Sql());
            const polluted: Record<string, unknown> = { ...child };
            delete polluted[field];
            await insert('runs', run(business(polluted)));
            const before = await ledgerCatalog();
            try {
              await expect(
                connection().query(sqlFile('')),
              ).rejects.toMatchObject({ code: '23514' });
            } finally {
              await connection().query('ROLLBACK');
            }
            expect(await ledgerCatalog()).toEqual(before);
            expect(
              (
                await connection().query(
                  `SELECT follow_up_job FROM ${prefix}_runs`,
                )
              ).rows,
            ).toEqual([{ follow_up_job: polluted }]);
          } finally {
            await connection().query('ROLLBACK');
            await connection().query(sqlFile('.rollback'));
            await connection().query(sqlFile(''));
          }
        },
      );
    it.each([...ledgerNames, `idx_${prefix}_expiry`])(
      'refuses concurrent post-preflight creation of %s without stamping or deleting the foreign relation',
      async (name) => {
        await connection().query(sqlFile('.rollback'));
        if (!pool) throw new Error('Fixture pool missing');
        const peer = await pool.connect();
        const index = name.startsWith('idx_');
        const pauseKey = `neo-scheduled-race:${schema}:${name}`;
        let pending: Promise<unknown> | undefined,
          refused: Promise<void> | undefined;
        try {
          await peer.query('SELECT pg_advisory_lock(hashtextextended($1,0))', [
            pauseKey,
          ]);
          const pid = (
            await connection().query<{ pid: number }>(
              'SELECT pg_backend_pid() AS pid',
            )
          ).rows[0].pid;
          const migration = sqlFile('').replace(
            '  -- preflight complete:',
            `  PERFORM pg_advisory_xact_lock(hashtextextended('${pauseKey}',0));\n  -- preflight complete:`,
          );
          pending = connection().query(migration);
          refused = expect(pending).rejects.toMatchObject({ code: '42P07' });
          let waiting = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            const activity = await peer.query<{ wait_event: string }>(
              'SELECT wait_event FROM pg_stat_activity WHERE pid=$1',
              [pid],
            );
            if (activity.rows[0]?.wait_event === 'advisory') {
              waiting = true;
              break;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
          }
          expect(waiting).toBe(true);
          const table = index ? 'foreign_index_owner' : name;
          await peer.query(
            `CREATE TABLE ${qualified}.${table}(sentinel text PRIMARY KEY); INSERT INTO ${qualified}.${table} VALUES ('foreign-race-data')`,
          );
          if (index)
            await peer.query(
              `CREATE INDEX ${name} ON ${qualified}.${table}(sentinel)`,
            );
          await peer.query(
            'SELECT pg_advisory_unlock(hashtextextended($1,0))',
            [pauseKey],
          );
          await refused;
          await connection().query('ROLLBACK');
          expect(
            (await peer.query(`SELECT sentinel FROM ${qualified}.${table}`))
              .rows,
          ).toEqual([{ sentinel: 'foreign-race-data' }]);
          expect(
            (
              await peer.query<{ marker: string | null }>(
                "SELECT obj_description($1::regclass,'pg_class') AS marker",
                [`${qualified}.${name}`],
              )
            ).rows[0].marker,
          ).toBeNull();
          expect(await presentLedgers()).toEqual(index ? [] : [name]);
        } finally {
          await peer.query('SELECT pg_advisory_unlock_all()');
          await pending?.catch(() => undefined);
          await refused?.catch(() => undefined);
          await connection().query('ROLLBACK');
          await peer.query(
            `DROP TABLE IF EXISTS ${qualified}.${
              index ? 'foreign_index_owner' : name
            }`,
          );
          peer.release();
          await connection().query(sqlFile(''));
        }
      },
    );
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
          { job: JSON.stringify({ ...job, sessionId: 'borrowed-session' }) },
          {
            job: JSON.stringify({
              ...job,
              actor: { ...job.actor, userId: 'borrowed-user' },
            }),
          },
          {
            job: JSON.stringify({
              ...job,
              actor: { ...job.actor, sessionId: 'borrowed-session' },
            }),
          },
          {
            job: JSON.stringify({
              ...job,
              actor: { ...job.actor, unknown: null },
            }),
          },
          {
            job: JSON.stringify({
              ...job,
              batchConfig: { ...job.batchConfig, unknown: null },
            }),
          },
          { job: JSON.stringify({ ...job, unknown: null }) },
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
    it.each([
      'version',
      'source',
      'taskType',
      'actor',
      'taskId',
      'jobId',
      'domain',
      'country',
      'plannedSlot',
      'intervalMinutes',
      'batchConfig',
      'requestedAt',
      'createdAt',
      'expiresAt',
    ])('rejects follow-up missing or JSON-null %s in either domain', (key) =>
      transaction(async () => {
        const missing: Record<string, unknown> = { ...child };
        delete missing[key];
        for (const value of [missing, { ...child, [key]: null }])
          await reject(() => insert('runs', run(business(value))), '23514');
      }),
    );
    it('rejects child borrowed identities, unknown nested keys, malformed UUID/job ID and changed completion clock/retention', () =>
      transaction(async () => {
        for (const changes of [
          { userId: 'borrowed-user' },
          { sessionId: 'borrowed-session' },
          { actor: { ...child.actor, userId: 'borrowed-user' } },
          { actor: { ...child.actor, sessionId: 'borrowed-session' } },
          { actor: { ...child.actor, unknown: null } },
          { batchConfig: { ...child.batchConfig, unknown: null } },
          { unknown: null },
          { taskId: job.taskId },
          { taskId: 'invalid' },
          { jobId: 'replacement' },
          {
            requestedAt: '2026-10-03T12:34:00.001Z',
            createdAt: '2026-10-03T12:34:00.001Z',
          },
          { createdAt: '2026-10-03T12:34:00.001Z' },
          { expiresAt: '2026-10-10T12:30:02.001Z' },
        ])
          await reject(
            () => insert('runs', run(business({ ...child, ...changes }))),
            '23514',
          );
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
