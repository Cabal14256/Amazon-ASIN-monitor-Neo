import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { controlAuthMaintenance } from '../src/auth-maintenance-control';
import { startAuthMaintenanceRuntime } from '../src/auth-maintenance-runtime';
import { AUTH_MAINTENANCE_SCHEDULES } from '../src/auth-maintenance-schedules';
import {
  eventually,
  maintenanceFixture,
} from './helpers/auth-maintenance-fixture';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'D4 real BullMQ and PostgreSQL maintenance',
  () => {
    let f: Awaited<ReturnType<typeof maintenanceFixture>>;
    beforeEach(async () => {
      f = await maintenanceFixture();
    });
    afterEach(async () => {
      if (f) await f.close();
    });

    it('two runtimes install exactly two Shanghai plans, deliver timed jobs, and transfer leadership without touching Legacy', async () => {
      const first = await f.start();
      const token = await f.redis.get(f.leaseKey);
      expect(token).toBeTruthy();
      const second = await f.start();
      expect(await f.redis.get(f.leaseKey)).toBe(token);
      expect(await f.redis.pttl(f.leaseKey)).toBeGreaterThan(0);
      const schedules = await f.queue.getJobSchedulers();
      expect(schedules).toHaveLength(2);
      for (const expected of AUTH_MAINTENANCE_SCHEDULES) {
        const actual = schedules.find(
          (schedule) => schedule.key === expected.id,
        )!;
        expect(actual).toMatchObject({
          name: expected.name,
          pattern: expected.pattern,
          tz: 'Asia/Shanghai',
        });
        const shanghai = new Date(actual.next! + 8 * 3600_000);
        expect(shanghai.getUTCMinutes()).toBe(0);
        expect(shanghai.getUTCHours()).toBe(
          expected.name === 'session-cleanup' ? 2 : 3,
        );
        if (expected.name === 'audit-archive')
          expect(shanghai.getUTCDate()).toBe(1);
      }
      await f.session('expired-timer');
      await f.session('future-timer', false);
      await f.audit(67);
      // Fixture-only second-level cron exercises BullMQ's actual timed delivery;
      // production cron definitions above remain unchanged.
      const scheduledStart = Date.now() + 1000;
      const jobs = await Promise.all(
        ['session-cleanup', 'audit-archive'].map((name) =>
          f.queue.upsertJobScheduler(
            `fixture-${name}`,
            {
              pattern: '* * * * * *',
              tz: 'Asia/Shanghai',
              startDate: scheduledStart,
              limit: 1,
            },
            { name, data: { schemaVersion: 1 } },
          ),
        ),
      );
      await Promise.all(
        jobs.map((job) => job.waitUntilFinished(f.events, 8000)),
      );
      for (const job of jobs)
        expect(
          (await f.queue.getJob(job.id!))?.processedOn,
        ).toBeGreaterThanOrEqual(scheduledStart);
      for (const name of ['session-cleanup', 'audit-archive'])
        await f.queue.removeJobScheduler(`fixture-${name}`);
      expect(
        (await f.pool.query('SELECT trim(id) AS id FROM sessions')).rows,
      ).toEqual([{ id: 'future-timer' }]);
      expect(
        (
          await f.pool.query(
            'SELECT count(*)::int AS n FROM audit_logs_archive',
          )
        ).rows[0].n,
      ).toBe(1);
      expect(
        (await f.pool.query('SELECT count(*)::int AS n FROM audit_logs_all'))
          .rows[0].n,
      ).toBe(1);
      expect(
        (await f.pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n,
      ).toBe(1);
      await first.close();
      await eventually(async () => {
        const next = await f.redis.get(f.leaseKey);
        return !!next && next !== token;
      });
      expect(await f.queue.getJobSchedulers()).toHaveLength(2);
      await second.close();
      expect(await f.redis.exists(f.leaseKey)).toBe(0);
      expect(await f.redis.lrange(f.legacyKey, 0, -1)).toEqual([
        'legacy-fixture',
      ]);
      expect(f.connectionErrors).toEqual([]);
      expect(f.fatal).toEqual([]);
    }, 20_000);

    it('retries PostgreSQL contention and resumes from committed state', async () => {
      await f.start(false);
      await f.session('retry-session');
      const lock = await f.pool.connect();
      try {
        await lock.query('SELECT pg_advisory_lock(1095977295,1)');
        const job = await f.queue.add('session-cleanup', { schemaVersion: 1 });
        await eventually(
          async () => (await f.queue.getJob(job.id!))?.attemptsMade === 1,
        );
        expect(await job.getState()).toBe('delayed');
        expect((await f.queue.getJob(job.id!))?.failedReason).toBe(
          'Authentication maintenance is busy',
        );
        await lock.query('SELECT pg_advisory_unlock(1095977295,1)');
        await expect(job.waitUntilFinished(f.events, 10_000)).resolves.toEqual({
          operation: 'session-cleanup',
          processed: 1,
          continued: false,
        });
        expect((await f.queue.getJob(job.id!))?.attemptsMade).toBe(2);
        expect(
          (await f.pool.query('SELECT count(*)::int AS n FROM sessions'))
            .rows[0].n,
        ).toBe(0);
      } finally {
        await lock.query('SELECT pg_advisory_unlock_all()');
        lock.release();
      }
    }, 15_000);

    it('rolls back an archive insert failure, sanitizes the persisted job, and retries successfully', async () => {
      await f.start(false);
      await f.audit(68);
      await f.pool.query(
        "CREATE FUNCTION fail_archive_67() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture-private-audit-secret'; END $$; CREATE TRIGGER fail_archive_67 AFTER INSERT ON audit_logs_archive FOR EACH ROW EXECUTE FUNCTION fail_archive_67()",
      );
      const job = await f.queue.add('audit-archive', { schemaVersion: 1 });
      await eventually(
        async () => (await f.queue.getJob(job.id!))?.attemptsMade === 1,
      );
      const failed = await f.queue.getJob(job.id!);
      expect(failed?.failedReason).toBe('Authentication maintenance failed');
      expect(JSON.stringify(failed?.stacktrace)).not.toContain(
        'fixture-private-audit-secret',
      );
      expect(
        (await f.pool.query('SELECT count(*)::int AS n FROM audit_logs'))
          .rows[0].n,
      ).toBe(1);
      expect(
        (
          await f.pool.query(
            'SELECT count(*)::int AS n FROM audit_logs_archive',
          )
        ).rows[0].n,
      ).toBe(0);
      await f.pool.query('DROP TRIGGER fail_archive_67 ON audit_logs_archive');
      await expect(job.waitUntilFinished(f.events, 10_000)).resolves.toEqual({
        operation: 'audit-archive',
        processed: 1,
        continued: false,
      });
      expect((await f.queue.getJob(job.id!))?.attemptsMade).toBe(2);
      expect(
        (
          await f.pool.query(
            'SELECT request_data, create_time::text AS time FROM audit_logs_all',
          )
        ).rows,
      ).toEqual([
        { request_data: { fixture: true }, time: '2000-01-01 00:00:00.123456' },
      ]);
    }, 15_000);

    it('keeps persisted plans for followers and respects durable stop through a process restart until explicit resume', async () => {
      const leader = await f.start();
      await leader.close();
      const follower = await f.start(false);
      expect(await f.queue.getJobSchedulers()).toHaveLength(2);
      expect(await f.redis.exists(f.leaseKey)).toBe(0);
      await follower.close();
      await controlAuthMaintenance('stop', f.queue);
      expect(await f.queue.isPaused()).toBe(true);
      expect(await f.queue.getJobSchedulers()).toHaveLength(0);
      await f.session('paused-session');
      const job = await f.queue.add('session-cleanup', { schemaVersion: 1 });
      await f.start();
      expect(await f.queue.isPaused()).toBe(true);
      expect(await f.queue.getJobSchedulers()).toHaveLength(2);
      expect(
        (await f.pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0]
          .n,
      ).toBe(1);
      expect(await job.getState()).toBe('waiting');
      await controlAuthMaintenance('resume', f.queue);
      await expect(
        job.waitUntilFinished(f.events, 8000),
      ).resolves.toMatchObject({ processed: 1 });
      expect(await f.queue.isPaused()).toBe(false);
    }, 15_000);

    it('rejects untrusted jobs as unrecoverable and leaves data untouched', async () => {
      await f.start(false);
      await f.session('invalid-job-session');
      const job = await f.queue.add('session-cleanup', {
        schemaVersion: 1,
        sql: 'fixture-untrusted-sql',
      });
      await expect(job.waitUntilFinished(f.events, 8000)).rejects.toThrow(
        'Invalid authentication maintenance job or authority',
      );
      expect((await f.queue.getJob(job.id!))?.attemptsMade).toBe(1);
      expect(
        (await f.pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0]
          .n,
      ).toBe(1);
    }, 12_000);

    it('continues a real archive beyond one job budget without duplicate or missing records', async () => {
      await f.start(false);
      // One eligible month per database batch forces a continuation after at most
      // 100 batches using only 101 records, without changing production limits.
      await f.pool.query(
        "INSERT INTO audit_logs(id,user_id,username,action,create_time) OVERRIDING SYSTEM VALUE SELECT 1000+i,'fixture-owner','fixture-owner','UPDATE',timestamp '2000-01-01' + i * interval '1 month' FROM generate_series(0,100) AS i",
      );
      const job = await f.queue.add('audit-archive', { schemaVersion: 1 });
      const first = await job.waitUntilFinished(f.events, 40_000);
      expect(first.continued).toBe(true);
      expect(first.processed).toBeGreaterThan(0);
      expect(first.processed).toBeLessThanOrEqual(100);
      await eventually(
        async () =>
          (
            await f.pool.query(
              'SELECT count(*)::int AS n FROM audit_logs_archive',
            )
          ).rows[0].n === 101,
        40_000,
      );
      expect(
        (
          await f.pool.query(
            'SELECT count(*)::int AS n, count(DISTINCT id)::int AS ids FROM audit_logs_all',
          )
        ).rows[0],
      ).toEqual({ n: 101, ids: 101 });
      expect(
        (await f.pool.query('SELECT count(*)::int AS n FROM audit_logs'))
          .rows[0].n,
      ).toBe(0);
      await eventually(async () => {
        const counts = await f.queue.getJobCounts(
          'active',
          'waiting',
          'delayed',
        );
        return Object.values(counts).every((count) => count === 0);
      });
      expect(await f.queue.getFailedCount()).toBe(0);
      expect(await f.queue.getCompletedCount()).toBeGreaterThanOrEqual(2);
    }, 90_000);

    it('fails closed on a missing migration, cleans startup resources, and can start after repair', async () => {
      await f.pool.query('DROP VIEW audit_logs_all');
      await expect(
        startAuthMaintenanceRuntime(f.env, () => undefined),
      ).rejects.toThrow('Authentication maintenance initialization failed');
      expect(await f.redis.exists(f.leaseKey)).toBe(0);
      expect(await f.queue.getJobSchedulers()).toHaveLength(0);
      await f.pool.query(
        'CREATE VIEW audit_logs_all AS SELECT * FROM audit_logs UNION ALL SELECT * FROM audit_logs_archive',
      );
      await f.start();
      expect(await f.queue.getJobSchedulers()).toHaveLength(2);
    }, 12_000);
  },
);
