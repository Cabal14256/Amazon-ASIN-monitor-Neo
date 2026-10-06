import type { ScheduledMonitorJob } from '@asin-monitor/contracts';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createPgPool } from '../src/client';
import {
  scheduledMonitorBatchIndex,
  scheduledMonitorGroupBatch,
  scheduledMonitorJobDigest,
} from '../src/domain/scheduled-monitor-policy';
import {
  scheduledMonitorGroupOperation,
  type ScheduledMonitorRun,
} from '../src/domain/scheduled-monitor-run';
import { PgScheduledMonitorRunRepository } from '../src/repositories/scheduled-monitor-run-repository';
import {
  scheduledGroup,
  scheduledJob,
  scheduledMember,
} from './helpers/scheduled-monitor-fixtures';

// Explicit isolated-service opt-in. No deployment dotenv or live table writes.
const suite =
  process.env.RUN_NEO_SCHEDULED_MONITOR_INTEGRATION === '1'
    ? describe
    : describe.skip;
const databases = new Map<string, string>();
suite.each(['primary', 'competitor'] as const)(
  '%s scheduled frozen run real PostgreSQL',
  (domain) => {
    const schema = `neo_scheduled_run_${domain}_${process.pid}_${randomUUID()
      .replaceAll('-', '')
      .slice(0, 8)}`;
    if (
      !/^neo_scheduled_run_(primary|competitor)_\d+_[a-f0-9]{8}$/.test(schema)
    )
      throw new Error('Invalid private fixture schema');
    const qualified = `"${schema}"`;
    const groupTable =
      domain === 'primary' ? 'variant_groups' : 'competitor_variant_groups';
    const memberTable = domain === 'primary' ? 'asins' : 'competitor_asins';
    const runTable = `${domain}_scheduled_monitor_runs`;
    const receiptTable = `${domain}_scheduled_monitor_group_receipts`;
    let pool: Pool | undefined,
      repository: PgScheduledMonitorRunRepository | undefined,
      created = false;
    const connection = () => {
      if (!pool) throw new Error('Fixture pool not connected');
      return pool;
    };
    const storage = () => {
      if (!repository) throw new Error('Fixture repository not ready');
      return repository;
    };
    const waitFor = async (probe: () => Promise<boolean>) => {
      const deadline = Date.now() + 2000;
      while (Date.now() < deadline) {
        if (await probe()) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(
        'Fixture did not observe the required PostgreSQL lock wait',
      );
    };
    const settled = <T>(promise: Promise<T>) =>
      promise.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    const nowJob = async (
      ageMinutes = 0,
      totalBatches = 1,
    ): Promise<ScheduledMonitorJob> => {
      const rows = await connection().query<{ now: Date }>(
        'SELECT clock_timestamp() AS now',
      );
      const requested = new Date(
        rows.rows[0].now.getTime() - ageMinutes * 60000,
      );
      const plannedSlot = new Date(
        Math.floor(requested.getTime() / 60000) * 60000,
      ).toISOString();
      return scheduledJob(domain, {
        plannedSlot,
        requestedAt: requested.toISOString(),
        createdAt: requested.toISOString(),
        expiresAt: new Date(
          requested.getTime() + 7 * 24 * 60 * 60000,
        ).toISOString(),
        batchConfig: {
          batchIndex: scheduledMonitorBatchIndex(
            Date.parse(plannedSlot),
            30,
            totalBatches,
          ),
          totalBatches,
        },
      });
    };
    const insertRows = async (
      table: string,
      rows: Record<string, unknown>[],
    ) => {
      if (![groupTable, memberTable].includes(table))
        throw new Error('Invalid fixture table');
      await connection().query(
        `INSERT INTO ${qualified}."${table}" SELECT * FROM jsonb_populate_recordset(NULL::${qualified}."${table}",$1::jsonb)`,
        [JSON.stringify(rows)],
      );
    };
    const insertReceipt = async (
      run: ScheduledMonitorRun,
      changes: Record<string, unknown> = {},
    ) => {
      const group = run.groups[0];
      const operation = scheduledMonitorGroupOperation(run.job, group);
      const result = {
        isBroken: false,
        brokenASINs: [],
        brokenByType: { SP_API_ERROR: 0, NOT_FOUND: 0, NO_VARIANTS: 0 },
        groupSnapshot: {
          id: group.group.id,
          name: group.group.name,
          country: group.country,
          children: group.members.map((member) => ({
            id: member.id,
            asin: member.asin,
          })),
        },
        details: {
          results: group.members.map((member) => ({
            asin: member.asin,
            hasVariants: true,
            variantCount: 2,
          })),
        },
      };
      const row = {
        ...Object.fromEntries(
          Object.entries(operation).map(([key, value]) => [
            key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`),
            value,
          ]),
        ),
        result: JSON.stringify(result),
        ...changes,
      };
      const columns = Object.keys(row);
      if (columns.some((column) => !/^[a-z_]+$/.test(column)))
        throw new Error('Invalid receipt fixture field');
      await connection().query(
        `INSERT INTO ${qualified}."${receiptTable}" (${columns.join(
          ',',
        )}) VALUES (${columns.map((_, index) => `$${index + 1}`).join(',')})`,
        Object.values(row),
      );
    };
    const summary = (run: ScheduledMonitorRun) => ({
      version: 1,
      totalGroups: run.groups.length,
      totalMembers: run.totalMembers,
      brokenGroups: 0,
      brokenMembers: 0,
    });
    beforeAll(async () => {
      const variable =
        domain === 'primary' ? 'DATABASE_URL' : 'COMPETITOR_DATABASE_URL';
      const url = process.env[variable];
      if (!url)
        throw new Error(`Scheduled snapshot fixture requires ${variable}`);
      pool = createPgPool(url, {
        max: 4,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 1000,
      });
      const database = await pool.query<{ name: string }>(
        'SELECT current_database() AS name',
      );
      databases.set(domain, database.rows[0].name);
      if (databases.size === 2)
        expect(databases.get('primary')).not.toBe(databases.get('competitor'));
      await pool.query(`CREATE SCHEMA ${qualified}`);
      created = true;
      const columns = (row: Record<string, unknown>) =>
        Object.entries(row)
          .map(([key, value]) => {
            if (!/^[a-z_]+$/.test(key))
              throw new Error('Invalid catalog fixture field');
            const type =
              key === 'id'
                ? 'varchar(50) PRIMARY KEY'
                : key.endsWith('_time') || key.endsWith('_at')
                ? 'timestamp(6) without time zone'
                : typeof value === 'boolean'
                ? 'boolean'
                : 'text';
            return `"${key}" ${type}`;
          })
          .join(',');
      await pool.query(
        `CREATE TABLE ${qualified}."${groupTable}" (${columns(
          scheduledGroup(domain),
        )})`,
      );
      await pool.query(
        `CREATE TABLE ${qualified}."${memberTable}" (${columns(
          scheduledMember(domain),
        )},FOREIGN KEY(variant_group_id) REFERENCES ${qualified}."${groupTable}"(id) ON DELETE CASCADE)`,
      );
      await pool.query(
        `CREATE TABLE ${qualified}."${
          domain === 'primary'
            ? 'monitor_history'
            : 'competitor_monitor_history'
        }" (id integer PRIMARY KEY); CREATE TABLE ${qualified}."${domain}_monitor_runs" (task_id text PRIMARY KEY,user_id text NOT NULL)`,
      );
      const migration = readFileSync(
        resolve(
          __dirname,
          `../migrations/0016_scheduled_monitor_${domain}.sql`,
        ),
        'utf8',
      ).replaceAll('public.', `${qualified}.`);
      await pool.query(migration);
      repository = new PgScheduledMonitorRunRepository(pool, domain, {
        schema,
      });
      await repository.assertReady();
    }, 30_000);
    beforeEach(async () => {
      await connection().query(
        `TRUNCATE ${qualified}."${runTable}",${qualified}."${groupTable}" CASCADE`,
      );
    });
    afterAll(async () => {
      repository?.close();
      try {
        if (created && pool)
          await pool.query(`DROP SCHEMA ${qualified} CASCADE`);
      } finally {
        await pool?.end();
      }
    });
    it('freezes full native members once; rename, new members, deletion and recreation do not change replay', async () => {
      const job = await nowJob();
      const group = scheduledGroup(domain),
        member = scheduledMember(domain);
      await insertRows(groupTable, [group]);
      await insertRows(memberTable, [member]);
      const original = await storage().accept(job);
      expect(original.state).toBe('pending');
      expect(original.groups[0].group).toEqual(group);
      expect(original.groups[0].members).toEqual([member]);
      await connection().query(
        `UPDATE ${qualified}."${groupTable}" SET name='changed' WHERE id=$1`,
        [group.id],
      );
      await insertRows(memberTable, [
        {
          ...scheduledMember(domain, group.id as string, 'new member'),
          asin: 'B000000002',
        },
      ]);
      expect((await storage().accept(job)).groups).toEqual(original.groups);
      await connection().query(
        `DELETE FROM ${qualified}."${groupTable}" WHERE id=$1`,
        [group.id],
      );
      await insertRows(groupTable, [
        {
          ...group,
          name: 'recreated',
          create_time: '2026-10-07 09:00:00.000002',
        },
      ]);
      expect(await storage().read(job)).toEqual(original);
    });
    it('serializes concurrent acceptance under one slot identity and returns one original snapshot', async () => {
      const job = await nowJob();
      await insertRows(groupTable, [scheduledGroup(domain)]);
      await insertRows(memberTable, [scheduledMember(domain)]);
      const peer = new PgScheduledMonitorRunRepository(connection(), domain, {
        schema,
      });
      try {
        const runs = await Promise.all([
          storage().accept(job),
          peer.accept(job),
        ]);
        expect(runs[0]).toEqual(runs[1]);
        expect(
          (
            await connection().query(
              `SELECT count(*)::integer AS n FROM ${qualified}."${runTable}"`,
            )
          ).rows[0].n,
        ).toBe(1);
      } finally {
        peer.close();
      }
    });
    it.each(['start', 'requestCancellation'] as const)(
      'refreshes the RR snapshot after %s actually waits for initial acceptance on another connection',
      async (operation) => {
        const job = await nowJob();
        await insertRows(groupTable, [scheduledGroup(domain)]);
        await insertRows(memberTable, [scheduledMember(domain)]);
        const blocker = await connection().connect();
        let released = false;
        let acceptance:
          | ReturnType<typeof settled<ScheduledMonitorRun>>
          | undefined;
        let transition:
          | ReturnType<typeof settled<ScheduledMonitorRun>>
          | undefined;
        try {
          await blocker.query('BEGIN');
          await blocker.query(
            `LOCK TABLE ${qualified}."${groupTable}" IN ACCESS EXCLUSIVE MODE`,
          );
          acceptance = settled(storage().accept(job));
          let accepterPid: number | undefined;
          await waitFor(async () => {
            const waiting = await connection().query<{ pid: number }>(
              `SELECT pid FROM pg_catalog.pg_locks WHERE relation=$1::regclass
               AND NOT granted AND mode='AccessShareLock'`,
              [`${qualified}."${groupTable}"`],
            );
            accepterPid = waiting.rows[0]?.pid;
            return typeof accepterPid === 'number';
          });
          transition = settled(storage()[operation](job));
          await waitFor(async () => {
            const waiting = await connection().query<{ waiting: boolean }>(
              `SELECT EXISTS (
                SELECT 1 FROM pg_catalog.pg_locks waiter JOIN pg_catalog.pg_locks holder
                  ON waiter.classid=holder.classid AND waiter.objid=holder.objid
                  AND waiter.objsubid=holder.objsubid AND waiter.database=holder.database
                WHERE holder.pid=$1 AND holder.locktype='advisory' AND holder.granted
                  AND waiter.locktype='advisory' AND NOT waiter.granted
              ) AS waiting`,
              [accepterPid],
            );
            return waiting.rows[0]?.waiting === true;
          });
          await blocker.query('COMMIT');
          blocker.release();
          released = true;
          const accepted = await acceptance;
          if (!accepted.ok) throw accepted.error;
          const changed = await transition;
          if (!changed.ok) throw changed.error;
          expect(changed.value.job).toEqual(accepted.value.job);
          expect(changed.value.groups).toEqual(accepted.value.groups);
          expect(changed.value.snapshotDigest).toBe(
            accepted.value.snapshotDigest,
          );
          expect(changed.value.state).toBe(
            operation === 'start' ? 'running' : 'pending',
          );
          if (operation === 'requestCancellation') {
            expect(changed.value.cancelRequestedAt).not.toBeNull();
            await expect(storage().start(job)).rejects.toMatchObject({
              code: 'cancelled',
            });
          } else {
            expect(changed.value.cancelRequestedAt).toBeNull();
          }
          expect(
            (
              await connection().query(
                `SELECT count(*)::integer AS n FROM ${qualified}."${runTable}" WHERE task_id=$1`,
                [job.taskId],
              )
            ).rows[0].n,
          ).toBe(1);
          expect(await storage().read(job)).toEqual(changed.value);
        } finally {
          if (!released) {
            try {
              await blocker.query('ROLLBACK');
            } finally {
              blocker.release();
            }
          }
          await Promise.all([acceptance, transition].filter(Boolean));
        }
      },
      30_000,
    );
    it('selects raw CRC32 batches before enforcing the selected group limit and preserves microsecond ordering', async () => {
      const job = await nowJob(0, 3);
      const groups = [' raw 😀 ', 'é', 'e\u0301', '😀', '\uE000', 'null'].map(
        (id, index) => ({
          ...scheduledGroup(domain, id),
          id,
          create_time:
            index === 5
              ? null
              : `2026-09-27 08:30:00.${String(index + 1).padStart(6, '0')}`,
        }),
      );
      await insertRows(groupTable, groups);
      const run = await storage().accept(job);
      const expected = groups
        .filter(
          (group) =>
            scheduledMonitorGroupBatch(group.id as string, 3) ===
            job.batchConfig.batchIndex,
        )
        .sort((a, b) =>
          a.create_time === null
            ? -1
            : b.create_time === null
            ? 1
            : a.create_time.localeCompare(b.create_time),
        );
      expect(run.groups.map((group) => group.group.id)).toEqual(
        expected.map((group) => group.id),
      );
    });
    it('rejects identity replacements and tampered member data without overwriting the run', async () => {
      const job = await nowJob();
      await insertRows(groupTable, [scheduledGroup(domain)]);
      await insertRows(memberTable, [scheduledMember(domain)]);
      const original = await storage().accept(job);
      await expect(
        storage().accept({
          ...job,
          expiresAt: new Date(Date.parse(job.expiresAt) + 1).toISOString(),
        }),
      ).rejects.toMatchObject({ code: 'identity' });
      await expect(
        Promise.resolve().then(() => storage().read({ ...job, country: 'UK' })),
      ).rejects.toMatchObject({ code: 'input' });
      const corrupted = structuredClone(original.groups);
      corrupted[0].members[0].asin = 'B000000009';
      await connection().query(
        `UPDATE ${qualified}."${runTable}" SET groups=$2::jsonb WHERE task_id=$1`,
        [job.taskId, JSON.stringify(corrupted)],
      );
      await expect(storage().accept(job)).rejects.toMatchObject({
        code: 'snapshot',
      });
    });
    it('records first-stale jobs without catalog reads, status writes, history or member selection', async () => {
      const job = await nowJob(26);
      await connection().query(
        `ALTER TABLE ${qualified}."${groupTable}" RENAME TO catalog_temporarily_unavailable`,
      );
      try {
        const run = await storage().accept(job);
        expect(run).toMatchObject({
          state: 'skipped-expired',
          groups: [],
          totalMembers: 0,
          result: null,
          followUpJob: null,
        });
        expect(run.completedAt).not.toBeNull();
        await expect(storage().start(job)).rejects.toMatchObject({
          code: 'state',
        });
      } finally {
        await connection().query(
          `ALTER TABLE ${qualified}.catalog_temporarily_unavailable RENAME TO "${groupTable}"`,
        );
      }
      expect(
        (
          await connection().query(
            `SELECT count(*)::integer AS n FROM ${qualified}."${
              domain === 'primary'
                ? 'monitor_history'
                : 'competitor_monitor_history'
            }"`,
          )
        ).rows[0].n,
      ).toBe(0);
    });
    it('rolls back an oversized catalog rather than saving a truncated snapshot', async () => {
      const job = await nowJob();
      await insertRows(
        groupTable,
        Array.from({ length: 1001 }, (_, index) =>
          scheduledGroup(domain, `group-${index}`),
        ),
      );
      await expect(storage().accept(job)).rejects.toMatchObject({
        code: 'capacity',
      });
      expect(
        (
          await connection().query(
            `SELECT count(*)::integer AS n FROM ${qualified}."${runTable}"`,
          )
        ).rows[0].n,
      ).toBe(0);
    });
    it('requires a cancellation request, protects terminal state and never restarts a cancelled run', async () => {
      const job = await nowJob();
      await storage().accept(job);
      await storage().start(job);
      await expect(
        storage().finishWithoutBusiness(job, 'cancelled'),
      ).rejects.toMatchObject({ code: 'cancelled' });
      await storage().requestCancellation(job);
      await expect(storage().start(job)).rejects.toMatchObject({
        code: 'cancelled',
      });
      const cancelled = await storage().finishWithoutBusiness(job, 'cancelled');
      expect(cancelled.completedAt).not.toBeNull();
      expect(await storage().finishWithoutBusiness(job, 'cancelled')).toEqual(
        cancelled,
      );
      await expect(
        storage().finishWithoutBusiness(job, 'failed'),
      ).rejects.toMatchObject({ code: 'state' });
    });
    it('requires matching transactional receipts, original member results and aggregate counts before business completion', async () => {
      const job = await nowJob();
      await insertRows(groupTable, [scheduledGroup(domain)]);
      await insertRows(memberTable, [scheduledMember(domain)]);
      const run = await storage().accept(job);
      await storage().start(job);
      await expect(
        storage().completeBusiness(job, summary(run)),
      ).rejects.toMatchObject({ code: 'state' });
      await insertReceipt(run, { request_hash: 'a'.repeat(64) });
      await expect(
        storage().completeBusiness(job, summary(run)),
      ).rejects.toMatchObject({ code: 'identity' });
      await connection().query(
        `DELETE FROM ${qualified}."${receiptTable}" WHERE task_id=$1`,
        [job.taskId],
      );
      await insertReceipt(run, {
        completed_at: new Date(
          Date.parse(job.expiresAt) + 60_000,
        ).toISOString(),
      });
      await expect(
        storage().completeBusiness(job, summary(run)),
      ).rejects.toMatchObject({ code: 'identity' });
      await connection().query(
        `DELETE FROM ${qualified}."${receiptTable}" WHERE task_id=$1`,
        [job.taskId],
      );
      await insertReceipt(run);
      await expect(
        storage().completeBusiness(job, { ...summary(run), brokenMembers: 1 }),
      ).rejects.toMatchObject({ code: 'identity' });
      const business = await storage().completeBusiness(
        job,
        summary(run),
        domain === 'primary',
      );
      expect(business.state).toBe('business-completed');
      expect(business.result).toEqual(summary(run));
      expect(business.followUpJob?.domain ?? null).toBe(
        domain === 'primary' ? 'competitor' : null,
      );
      if (business.followUpJob) {
        expect(business.followUpJob.requestedAt).toBe(
          business.businessCompletedAt,
        );
        expect(business.followUpDigest).toBe(
          scheduledMonitorJobDigest(business.followUpJob),
        );
      }
      expect(
        await storage().completeBusiness(
          job,
          summary(run),
          domain === 'primary',
        ),
      ).toEqual(business);
      // Once committed, a late cancellation cannot revoke business or rewrite its
      // child identity. Consumer replay only delivers that original child.
      expect(await storage().requestCancellation(job)).toEqual(business);
      await connection().query(`DELETE FROM ${qualified}."${groupTable}"`);
      const completed = await storage().complete(job);
      expect(completed.state).toBe('completed');
      expect(completed.followUpJob).toEqual(business.followUpJob);
      expect(await storage().complete(job)).toEqual(completed);
      await expect(
        Promise.resolve().then(() =>
          storage().completeBusiness(job, summary(run), domain !== 'primary'),
        ),
      ).rejects.toMatchObject({
        code: domain === 'primary' ? 'identity' : 'input',
      });
      expect(await storage().read(job)).toEqual(completed);
    });
    if (domain === 'primary')
      it('rejects replaced US child clocks in SQL and a forged digest on read without losing the original child', async () => {
        const job = await nowJob();
        await insertRows(groupTable, [scheduledGroup(domain)]);
        await insertRows(memberTable, [scheduledMember(domain)]);
        const run = await storage().accept(job);
        await storage().start(job);
        await insertReceipt(run);
        const business = await storage().completeBusiness(
          job,
          summary(run),
          true,
        );
        const original = business.followUpJob;
        if (!original) throw new Error('Fixture child was not persisted');
        const later = new Date(
          Date.parse(original.requestedAt) + 1,
        ).toISOString();
        for (const changes of [
          { requestedAt: later, createdAt: later },
          { createdAt: later },
          {
            expiresAt: new Date(
              Date.parse(original.expiresAt) + 1,
            ).toISOString(),
          },
        ]) {
          const child = { ...original, ...changes };
          await expect(
            connection().query(
              `UPDATE ${qualified}."${runTable}" SET follow_up_job=$2::jsonb,follow_up_digest=$3,follow_up_requested_at=$4::timestamptz WHERE task_id=$1`,
              [
                job.taskId,
                JSON.stringify(child),
                scheduledMonitorJobDigest(child),
                child.requestedAt,
              ],
            ),
          ).rejects.toMatchObject({ code: '23514' });
          expect(await storage().read(job)).toEqual(business);
        }
        await connection().query(
          `UPDATE ${qualified}."${runTable}" SET follow_up_digest=$2 WHERE task_id=$1`,
          [job.taskId, 'a'.repeat(64)],
        );
        await expect(storage().read(job)).rejects.toMatchObject({
          code: 'identity',
        });
        await expect(storage().complete(job)).rejects.toMatchObject({
          code: 'identity',
        });
        await connection().query(
          `UPDATE ${qualified}."${runTable}" SET follow_up_digest=$2 WHERE task_id=$1`,
          [job.taskId, business.followUpDigest],
        );
        expect(await storage().read(job)).toEqual(business);
        expect((await storage().complete(job)).followUpJob).toEqual(original);
      });
  },
);
