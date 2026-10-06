import type { PrimaryMonitorJob } from '@asin-monitor/contracts';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createDb, createPgPool } from '../src/client';
import type {
  CatalogOperationIdentity,
  CatalogTaskBinding,
} from '../src/domain/catalog-operation';
import { withAsinDatabaseTransaction } from '../src/repositories/asin-query-repository';
import { DrizzleAsinWriteUnit } from '../src/repositories/asin-write-repository';
import { withCatalogOperationExecution } from '../src/repositories/catalog-operation-execution';
import { PgCatalogOperationRepository } from '../src/repositories/catalog-operation-repository';
import { PgPrimaryMonitorRepository } from '../src/repositories/primary-monitor-repository';

// Synthetic private schema only. No .env loading, public writes or expiry-based recovery.
describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'catalog fence / real isolated PostgreSQL',
  () => {
    const schema = `neo_catalog_224_${process.pid}_${randomUUID()
      .replaceAll('-', '')
      .slice(0, 8)}`;
    if (!/^neo_catalog_224_\d+_[a-f0-9]{8}$/.test(schema))
      throw new Error('Invalid fixture schema');
    const qualified = `"${schema}"`;
    let control: Pool, pool: Pool, repository: PgCatalogOperationRepository;
    let created = false;
    const upgrade = readFileSync(
      resolve(__dirname, '../migrations/0017_catalog_operation_fence.sql'),
      'utf8',
    )
      .replaceAll('public.', `${qualified}.`)
      .replaceAll('pg_catalog, public', `pg_catalog, ${qualified}`);
    const rollback = readFileSync(
      resolve(
        __dirname,
        '../migrations/0017_catalog_operation_fence.rollback.sql',
      ),
      'utf8',
    )
      .replaceAll('public.', `${qualified}.`)
      .replaceAll('pg_catalog, public', `pg_catalog, ${qualified}`);
    async function migration(text = upgrade) {
      const client = await pool.connect();
      try {
        await client.query(text);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    }
    const reserve = (
      ownerId = 'owner',
      domain: 'asin' | 'competitor' = 'asin',
    ) =>
      repository.reserve(
        { ownerId, domain, kind: 'write' },
        async () => undefined,
      );
    const task: CatalogTaskBinding = {
      userId: 'owner',
      taskId: randomUUID(),
      taskType: 'import',
      taskSubType: 'asin',
      createdAt: '2026-10-07T00:00:00.000Z',
    };
    async function imported() {
      const identity = await repository.reserve(
        {
          ownerId: task.userId,
          domain: 'asin',
          kind: 'import',
          expectedTaskId: task.taskId,
        },
        async () => undefined,
      );
      await repository.bindTask(identity, task);
      return identity;
    }
    async function complete(identity: CatalogOperationIdentity) {
      await repository.close(identity, { status: 'completed', source: 'sync' });
      expect(await repository.release(identity)).toBe(true);
    }
    beforeAll(async () => {
      const url = process.env.DATABASE_URL;
      if (!url)
        throw new Error('Explicit integration DATABASE_URL is required');
      control = createPgPool(url, { max: 1, connectionTimeoutMillis: 3000 });
      await control.query(`CREATE SCHEMA ${qualified}`);
      created = true;
      pool = createPgPool(url, {
        max: 6,
        connectionTimeoutMillis: 3000,
        options: `-c search_path=${schema},pg_catalog`,
      });
      repository = new PgCatalogOperationRepository(pool);
      await pool.query(`CREATE TABLE users(id varchar(50) PRIMARY KEY, status varchar(20), locked_until timestamp, force_password_change boolean, password_expires_at timestamp);
      INSERT INTO users VALUES('owner','active',NULL,false,NULL);`);
      // Actual frozen baseline business table definitions, without public/bootstrap DDL.
      const baseline = readFileSync(
        resolve(__dirname, '../migrations/0000_baseline.sql'),
        'utf8',
      );
      for (const table of ['variant_groups', 'asins', 'monitor_history']) {
        const ddl = baseline.match(
          new RegExp(
            `CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`,
          ),
        )?.[0];
        if (!ddl) throw new Error('Missing actual baseline fixture table');
        await pool.query(ddl);
      }
      await pool.query(
        readFileSync(
          resolve(__dirname, '../migrations/0012_primary_monitor.sql'),
          'utf8',
        ).replaceAll('public.', `${qualified}.`),
      );
    });
    beforeEach(async () => {
      await pool.query(
        'DROP TABLE IF EXISTS catalog_operation_pins; DROP TABLE IF EXISTS catalog_operation_slots; DELETE FROM primary_monitor_runs; DELETE FROM monitor_history; DELETE FROM asins; DELETE FROM variant_groups;',
      );
      await migration();
    });
    afterAll(async () => {
      await pool?.end();
      if (created) await control.query(`DROP SCHEMA ${qualified} CASCADE`);
      await control?.end();
    });
    it('arbitrates the first absent-slot race: exactly one caller owns the durable reservation', async () => {
      const results = await Promise.allSettled([reserve(), reserve()]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected');
      expect(rejected?.status === 'rejected' && rejected.reason).toMatchObject({
        code: 'CATALOG_OPERATION_BUSY',
        snapshot: { ownerId: 'owner', state: 'open' },
      });
      const current = await repository.read('owner', 'asin');
      expect(current).toMatchObject({ generation: '1', pendingPins: 0 });
    });
    it('checks current authorization in the same SQL transaction, and never reserves after its rejection', async () => {
      await expect(
        repository.reserve(
          { ownerId: 'owner', domain: 'asin', kind: 'write' },
          async (unit) => {
            expect(await unit.lockOperator('owner')).toMatchObject({
              status: 'active',
            });
            throw new Error('current permission rejected');
          },
        ),
      ).rejects.toThrow('current permission rejected');
      expect(await repository.read('owner', 'asin')).toBeNull();
      expect(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM catalog_operation_slots',
          )
        ).rows[0].n,
      ).toBe(0);
    });
    it('keeps owner/domain/literal-case independent and never expires an old fence', async () => {
      const identities = await Promise.all([
        reserve('Owner'),
        reserve('owner'),
        reserve('owner', 'competitor'),
        reserve(' '),
      ]);
      expect(new Set(identities.map((value) => value.operationId)).size).toBe(
        4,
      );
      await pool.query(
        "UPDATE catalog_operation_slots SET updated_at='1998-01-01'",
      );
      await expect(reserve('Owner')).rejects.toMatchObject({
        code: 'CATALOG_OPERATION_BUSY',
      });
      expect(await repository.read(' ', 'asin')).toMatchObject({
        ownerId: ' ',
        state: 'open',
      });
    });
    it('rejects actual business writes without a server scope before issuing the INSERT', async () => {
      await expect(
        withAsinDatabaseTransaction(pool, (db, ensureOpen) =>
          new DrizzleAsinWriteUnit(db, ensureOpen).createGroup({
            name: 'stale bundle',
            country: 'US',
            site: 'fixture',
            brand: 'fixture',
          }),
        ),
      ).rejects.toMatchObject({ code: 'CATALOG_OPERATION_MISSING' });
      expect(
        (await pool.query('SELECT count(*)::int AS n FROM variant_groups'))
          .rows[0].n,
      ).toBe(0);
    });
    it('pins actual monitor snapshots and notification history until the blocked physical COMMIT settles', async () => {
      const monitor = new PgPrimaryMonitorRepository(pool);
      const binding: CatalogTaskBinding = {
        ...task,
        taskId: randomUUID(),
        taskType: 'monitor',
        taskSubType: 'primary',
      };
      const job: PrimaryMonitorJob = {
        ...binding,
        taskType: 'monitor',
        taskSubType: 'primary',
        countries: ['US'],
        expiresAt: '2099-10-08T00:00:00.000Z',
      };
      await pool.query(
        "INSERT INTO variant_groups(id,name,country,site,brand) VALUES('literal group ','synthetic','US','fixture','fixture')",
      );
      await expect(monitor.groups(job)).rejects.toMatchObject({
        code: 'CATALOG_OPERATION_MISSING',
      });
      expect(
        (
          await pool.query(
            'SELECT count(*)::int AS n FROM primary_monitor_runs',
          )
        ).rows[0].n,
      ).toBe(0);
      const identity = await repository.reserve(
        { ownerId: task.userId, domain: 'asin', kind: 'monitor' },
        async () => undefined,
      );
      await repository.bindTask(identity, binding);
      await withCatalogOperationExecution(repository, identity, async () => {
        expect(await monitor.groups(job)).toEqual([
          { groupId: 'literal group ', country: 'US' },
        ]);
        expect(await monitor.claimNotification(job.taskId, 'US')).toBe('new');
      });
      await pool.query(
        "INSERT INTO monitor_history(country,check_time,is_broken,monitor_task_id) VALUES('US','2026-10-07 08:00:00',true,$1)",
        [job.taskId],
      );
      const lockName = `${schema}:monitor-complete`;
      await pool.query(`CREATE FUNCTION ${qualified}.wait_monitor_notification() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN PERFORM pg_advisory_xact_lock(hashtextextended('${lockName}',0)); RETURN NEW; END $$;
        CREATE TRIGGER wait_monitor_notification BEFORE UPDATE ON primary_monitor_notifications
        FOR EACH ROW EXECUTE FUNCTION ${qualified}.wait_monitor_notification();`);
      const blocker = await pool.connect();
      let pending: Promise<void> | undefined;
      let releasing: Promise<boolean> | undefined;
      try {
        await blocker.query('BEGIN');
        const blockerPid = Number(
          (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
        );
        await blocker.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [lockName],
        );
        pending = withCatalogOperationExecution(repository, identity, () =>
          monitor.completeNotification(job.taskId, 'US', true),
        );
        await vi.waitFor(async () => {
          expect(
            (
              await pool.query(
                'SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',
                [blockerPid],
              )
            ).rows[0].n,
          ).toBe(1);
        });
        expect(await repository.read(task.userId, 'asin')).toMatchObject({
          pendingPins: 1,
          uncertainPins: 0,
        });
        // The actual business transaction holds FOR SHARE on the slot through
        // COMMIT. Release must wait for that lock, rather than synchronously
        // return while this fixture still holds the notification blocker.
        releasing = repository.release(identity);
        void releasing.catch(() => undefined);
        await vi.waitFor(async () => {
          expect(
            (
              await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE pid<>pg_backend_pid() AND wait_event_type='Lock'
                AND query LIKE '%catalog_operation_slots%'`)
            ).rows[0].n,
          ).toBe(1);
        });
        expect(
          (await pool.query('SELECT notification_sent FROM monitor_history'))
            .rows[0].notification_sent,
        ).toBe(false);
        await blocker.query('COMMIT');
        await pending;
        expect(await releasing).toBe(false);
        expect(await repository.read(task.userId, 'asin')).toMatchObject({
          pendingPins: 0,
          uncertainPins: 0,
        });
        expect(
          (await pool.query('SELECT notification_sent FROM monitor_history'))
            .rows[0].notification_sent,
        ).toBe(true);
        await repository.close(identity, {
          source: 'worker',
          status: 'completed',
          task: binding,
        });
        expect(await repository.release(identity)).toBe(true);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await pending;
        await releasing;
        await pool.query(`DROP TRIGGER wait_monitor_notification ON primary_monitor_notifications;
          DROP FUNCTION ${qualified}.wait_monitor_notification();`);
      }
    });
    it('holds the exact slot/pin SQL locks through business COMMIT, blocking concurrent generation close', async () => {
      const identity = await reserve();
      const client = await pool.connect();
      let pid = 0;
      let proceed!: () => void, ready!: () => void;
      const wait = new Promise<void>((resolve) => {
        proceed = resolve;
      });
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const business = withCatalogOperationExecution(repository, identity, () =>
        withAsinDatabaseTransaction(pool, async (db, ensureOpen) => {
          pid = Number(
            (await db.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0].pid,
          );
          const result = await new DrizzleAsinWriteUnit(
            db,
            ensureOpen,
          ).createGroup({
            name: 'committed fixture',
            country: 'US',
            site: 'fixture',
            brand: 'fixture',
          });
          ready();
          await wait;
          return result;
        }),
      );
      try {
        await started;
        const closing = repository.close(identity, {
          status: 'completed',
          source: 'sync',
        });
        await vi.waitFor(
          async () => {
            const blocked = await client.query(
              'SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND $1=ANY(pg_blocking_pids(pid))',
              [pid],
            );
            expect(blocked.rows[0].n).toBeGreaterThan(0);
          },
          { timeout: 1000, interval: 10 },
        );
        expect(
          (await pool.query('SELECT count(*)::int AS n FROM variant_groups'))
            .rows[0].n,
        ).toBe(0);
        proceed();
        await business;
        await closing;
        expect(await repository.read('owner', 'asin')).toMatchObject({
          state: 'closed',
          pendingPins: 0,
          uncertainPins: 0,
        });
        expect(await repository.release(identity)).toBe(true);
        expect(
          (await pool.query('SELECT count(*)::int AS n FROM variant_groups'))
            .rows[0].n,
        ).toBe(1);
      } finally {
        proceed();
        await Promise.allSettled([business]);
        client.release();
      }
    });
    it('refuses a late transaction after generation close, while settling its already-reserved pin', async () => {
      const identity = await reserve(),
        pin = await repository.beginPin(identity);
      await repository.close(identity, { status: 'cancelled', source: 'sync' });
      expect(await repository.release(identity)).toBe(false);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await expect(
          repository.assertPin(createDb(client), pin),
        ).rejects.toMatchObject({ code: 'CATALOG_OPERATION_CLOSED' });
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      await repository.finishPin(pin, 'rolled-back');
      expect(await repository.release(identity)).toBe(true);
    });
    it('never releases pending or uncertain physical work, even with a known terminal task', async () => {
      const identity = await imported(),
        pin = await repository.beginPin(identity);
      await repository.close(identity, {
        status: 'failed',
        source: 'worker',
        task,
      });
      expect(await repository.release(identity)).toBe(false);
      await repository.finishPin(pin, 'uncertain');
      expect(await repository.read('owner', 'asin')).toMatchObject({
        state: 'uncertain',
        pendingPins: 0,
        uncertainPins: 1,
      });
      expect(await repository.release(identity)).toBe(false);
      await expect(
        repository.finishPin(pin, 'rolled-back'),
      ).rejects.toMatchObject({ code: 'CATALOG_OPERATION_IDENTITY' });
      await expect(reserve()).rejects.toMatchObject({
        code: 'CATALOG_OPERATION_BUSY',
      });
    });
    it('makes task binding immutable before submission and validates every field when finding a worker fence', async () => {
      const identity = await imported();
      await repository.bindTask(identity, task);
      expect(await repository.findByTask(task)).toEqual(identity);
      for (const patch of [
        { userId: 'other' },
        { taskId: randomUUID() },
        { taskType: 'batch-delete' as const },
        { taskSubType: 'competitor-asin' },
        { createdAt: '2026-10-07T00:00:01.000Z' },
      ]) {
        await expect(
          repository.findByTask({ ...task, ...patch }),
        ).rejects.toBeInstanceOf(Error);
      }
      await expect(
        repository.bindTask(identity, {
          ...task,
          createdAt: '2026-10-07T00:00:01.000Z',
        }),
      ).rejects.toMatchObject({ code: 'CATALOG_OPERATION_IDENTITY' });
      await expect(
        repository.close(identity, { status: 'completed', source: 'sync' }),
      ).rejects.toMatchObject({ code: 'CATALOG_OPERATION_IDENTITY' });
      await repository.close(identity, {
        status: 'cancelled',
        source: 'cancel',
        task,
      });
      expect(await repository.findByTask(task)).toEqual(identity);
      await expect(repository.beginPin(identity)).rejects.toMatchObject({
        code: 'CATALOG_OPERATION_CLOSED',
      });
      await expect(repository.bindTask(identity, task)).rejects.toMatchObject({
        code: 'CATALOG_OPERATION_CLOSED',
      });
      expect(await repository.release(identity)).toBe(true);
    });
    it('binds a parent query with durable check receipt only to the primary check operation', async () => {
      const parent = {
        ...task,
        taskType: 'variant-check' as const,
        taskSubType: 'parent-asin-query',
      };
      const identity = await repository.reserve(
        { ownerId: task.userId, domain: 'asin', kind: 'check' },
        async () => undefined,
      );
      await repository.bindTask(identity, parent);
      expect(await repository.findByTask(parent)).toEqual(identity);
      await expect(
        Promise.resolve().then(() =>
          repository.bindTask(identity, { ...parent, taskType: 'batch-check' }),
        ),
      ).rejects.toMatchObject({ code: 'CATALOG_OPERATION_IDENTITY' });
      const competitor = await repository.reserve(
        { ownerId: task.userId, domain: 'competitor', kind: 'check' },
        async () => undefined,
      );
      await expect(
        Promise.resolve().then(() => repository.bindTask(competitor, parent)),
      ).rejects.toMatchObject({ code: 'CATALOG_OPERATION_IDENTITY' });
      await repository.close(identity, {
        source: 'worker',
        status: 'completed',
        task: parent,
      });
      expect(await repository.release(identity)).toBe(true);
      await complete(competitor);
    });
    it('binds a task allocated inside admission atomically once, while retaining its original operation', async () => {
      const identity = await repository.reserve(
        { ownerId: 'owner', domain: 'asin', kind: 'import' },
        async () => undefined,
      );
      expect(await repository.read('owner', 'asin')).toMatchObject({
        operationId: identity.operationId,
        expectedTaskId: null,
        task: null,
      });
      const alternative = { ...task, taskId: randomUUID() };
      const results = await Promise.allSettled([
        repository.bindTask(identity, task),
        repository.bindTask(identity, alternative),
      ]);
      expect(
        results.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      const failed = results.find((result) => result.status === 'rejected');
      expect(failed?.status === 'rejected' && failed.reason).toMatchObject({
        code: 'CATALOG_OPERATION_IDENTITY',
      });
      const current = await repository.read('owner', 'asin');
      expect(current).toMatchObject({
        operationId: identity.operationId,
        expectedTaskId: current?.task?.taskId,
      });
      const accepted = current!.task!;
      await repository.bindTask(identity, accepted);
      await expect(
        repository.bindTask(identity, {
          ...accepted,
          createdAt: '2026-10-07T00:00:01.000Z',
        }),
      ).rejects.toMatchObject({ code: 'CATALOG_OPERATION_IDENTITY' });
      await repository.close(identity, {
        status: 'rejected',
        source: 'producer',
        task: accepted,
      });
      expect(await repository.release(identity)).toBe(true);
    });
    it('requires a precise bound task and definite rejection for producer release, never a generic failed or unbound proof', async () => {
      const identity = await imported();
      await expect(
        Promise.resolve().then(() =>
          repository.close(identity, {
            status: 'failed',
            source: 'producer',
            task,
          }),
        ),
      ).rejects.toMatchObject({ code: 'CATALOG_OPERATION_INVALID' });
      await expect(
        repository.close(identity, {
          status: 'rejected',
          source: 'producer',
          task: { ...task, createdAt: '2026-10-07T00:00:01.000Z' },
        }),
      ).rejects.toMatchObject({ code: 'CATALOG_OPERATION_IDENTITY' });
      await expect(
        Promise.resolve().then(() =>
          repository.close(identity, {
            status: 'rejected',
            source: 'producer',
          }),
        ),
      ).rejects.toMatchObject({ code: 'CATALOG_OPERATION_INVALID' });
      expect(await repository.release(identity)).toBe(false);
      await repository.close(identity, {
        status: 'rejected',
        source: 'producer',
        task,
      });
      expect(await repository.release(identity)).toBe(true);
      const unbound = await reserve();
      await expect(
        Promise.resolve().then(() => repository.bindTask(unbound, task)),
      ).rejects.toMatchObject({
        code: 'CATALOG_OPERATION_IDENTITY',
      });
      await expect(
        repository.close(unbound, {
          status: 'rejected',
          source: 'producer',
          task,
        }),
      ).rejects.toMatchObject({ code: 'CATALOG_OPERATION_IDENTITY' });
    });
    it('keeps reservation and actual authorization in the same slot-before-user lock order', async () => {
      const identity = await reserve();
      let proceed!: () => void,
        ready!: () => void,
        pid = 0;
      const gate = new Promise<void>((resolve) => {
        proceed = resolve;
      });
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const business = withCatalogOperationExecution(repository, identity, () =>
        withAsinDatabaseTransaction(pool, async (db, ensureOpen) => {
          pid = Number(
            (await db.execute(sql`SELECT pg_backend_pid() AS pid`)).rows[0].pid,
          );
          ready();
          await gate;
          const unit = new DrizzleAsinWriteUnit(db, ensureOpen);
          expect(await unit.lockOperator('owner')).toMatchObject({
            status: 'active',
          });
          return unit.createGroup({
            name: 'auth lock order',
            country: 'US',
            site: 'fixture',
            brand: 'fixture',
          });
        }),
      );
      let contender: Promise<CatalogOperationIdentity> | undefined;
      try {
        await started;
        contender = repository.reserve(
          { ownerId: 'owner', domain: 'asin', kind: 'write' },
          async (unit) => {
            await unit.lockOperator('owner');
          },
        );
        const rejected = expect(contender).rejects.toMatchObject({
          code: 'CATALOG_OPERATION_BUSY',
        });
        await vi.waitFor(
          async () => {
            expect(
              (
                await pool.query(
                  'SELECT count(*)::int AS n FROM pg_locks WHERE NOT granted AND $1=ANY(pg_blocking_pids(pid))',
                  [pid],
                )
              ).rows[0].n,
            ).toBeGreaterThan(0);
          },
          { timeout: 1000, interval: 10 },
        );
        proceed();
        await business;
        await rejected;
        await complete(identity);
      } finally {
        proceed();
        await Promise.allSettled([business, ...(contender ? [contender] : [])]);
      }
    });
    it('CAS rejects old generation/operation completions after the next reservation starts', async () => {
      const old = await reserve();
      await complete(old);
      const next = await reserve();
      expect(next.generation).toBe('2');
      for (const action of [
        () => repository.close(old),
        () => repository.release(old),
        () => repository.beginPin(old),
      ]) {
        await expect(action()).rejects.toMatchObject({
          code: 'CATALOG_OPERATION_IDENTITY',
        });
      }
      expect(await repository.read('owner', 'asin')).toMatchObject({
        operationId: next.operationId,
        state: 'open',
      });
    });
    it('requires explicit terminal proof in addition to all settled pins, including an unbound failed submission', async () => {
      const identity = await repository.reserve(
        {
          ownerId: 'owner',
          domain: 'asin',
          kind: 'import',
          expectedTaskId: randomUUID(),
        },
        async () => undefined,
      );
      const pin = await repository.beginPin(identity);
      await repository.finishPin(pin, 'rolled-back');
      await repository.close(identity);
      expect(await repository.release(identity)).toBe(false);
      await repository.close(identity, { status: 'rejected', source: 'sync' });
      expect(await repository.release(identity)).toBe(true);
    });
    it('treats JSONB object-key order as irrelevant while refusing contradictory terminal proof', async () => {
      const identity = await imported();
      const proof = {
        status: 'completed' as const,
        source: 'worker' as const,
        task,
      };
      await repository.close(identity, proof);
      await repository.close(identity, proof);
      await expect(
        repository.close(identity, { ...proof, status: 'failed' }),
      ).rejects.toMatchObject({ code: 'CATALOG_OPERATION_IDENTITY' });
      expect(await repository.release(identity)).toBe(true);
    });
    it('converges cancel/worker cancelled proofs only for the same bound task, retaining the first proof and physical pin', async () => {
      const identity = await imported(),
        pin = await repository.beginPin(identity);
      await repository.close(identity, {
        status: 'cancelled',
        source: 'cancel',
        task,
      });
      await repository.close(identity, {
        status: 'cancelled',
        source: 'worker',
        task,
      });
      expect(await repository.read('owner', 'asin')).toMatchObject({
        terminal: { status: 'cancelled', source: 'cancel', task },
        pendingPins: 1,
      });
      expect(await repository.release(identity)).toBe(false);
      await expect(
        repository.close(identity, {
          status: 'completed',
          source: 'worker',
          task,
        }),
      ).rejects.toMatchObject({ code: 'CATALOG_OPERATION_IDENTITY' });
      await expect(
        repository.close(identity, {
          status: 'cancelled',
          source: 'worker',
          task: { ...task, createdAt: '2026-10-07T00:00:01.000Z' },
        }),
      ).rejects.toMatchObject({ code: 'CATALOG_OPERATION_IDENTITY' });
      await repository.finishPin(pin, 'rolled-back');
      expect(await repository.release(identity)).toBe(true);
    });
    it.each([
      'kind=NULL',
      "terminal='{}'::jsonb,state='closed'",
      `terminal='{"status":"completed","source":"worker"}'::jsonb,state='closed'`,
      "task_id='00000000-0000-4000-8000-000000000224',task_type='import',task_sub_type='asin',task_created_at='2026-10-07T00:00:00.000Z'",
    ])(
      'rejects missing required SQL values despite CHECK NULL three-valued logic: %s',
      async (change) => {
        await reserve();
        await expect(
          pool.query(`UPDATE catalog_operation_slots SET ${change}`),
        ).rejects.toMatchObject({ code: '23514' });
      },
    );
    it('runs upgrade twice, detects drift and refuses rollback of unresolved or structurally changed state', async () => {
      await migration();
      const identity = await reserve();
      await expect(migration(rollback)).rejects.toThrow('unresolved');
      await complete(identity);
      await pool.query(
        'ALTER TABLE catalog_operation_slots ADD COLUMN drift text',
      );
      await expect(migration()).rejects.toThrow('structural drift');
      await expect(migration(rollback)).rejects.toThrow('structural drift');
      await pool.query('ALTER TABLE catalog_operation_slots DROP COLUMN drift');
      // Reverting the extra live column restores the owned logical structure.
      await migration();
    });
    it('rolls back only owned idle tables and safely reapplies after two no-op rollbacks', async () => {
      await migration(rollback);
      await migration(rollback);
      await migration();
      await migration();
      expect(
        (
          await pool.query(
            "SELECT to_regclass('catalog_operation_slots')::text AS name",
          )
        ).rows[0].name,
      ).toBe('catalog_operation_slots');
    });
    it('refuses the first conflicting object instead of adopting or erasing it', async () => {
      await migration(rollback);
      await pool.query(
        "CREATE TABLE catalog_operation_slots(id text); INSERT INTO catalog_operation_slots VALUES('preserved')",
      );
      await expect(migration()).rejects.toThrow('partial/conflicting');
      expect(
        (await pool.query('SELECT id FROM catalog_operation_slots')).rows,
      ).toEqual([{ id: 'preserved' }]);
    });
    it('rolls back first-time creation on an existing index-name collision, retaining the foreign object', async () => {
      await migration(rollback);
      await pool.query(
        'CREATE UNIQUE INDEX uq_catalog_operation_task ON users(id)',
      );
      try {
        await expect(migration()).rejects.toMatchObject({ code: '42P07' });
        expect(
          (
            await pool.query(
              "SELECT to_regclass('catalog_operation_slots') AS slots, to_regclass('catalog_operation_pins') AS pins",
            )
          ).rows[0],
        ).toEqual({ slots: null, pins: null });
        expect(
          (
            await pool.query(
              "SELECT indrelid::regclass::text AS name FROM pg_index WHERE indexrelid='uq_catalog_operation_task'::regclass",
            )
          ).rows[0].name,
        ).toBe('users');
      } finally {
        await pool.query('DROP INDEX uq_catalog_operation_task');
      }
    });
    it('rejects a NULL settled outcome and a pin whose immutable identity belongs to another generation', async () => {
      const identity = await reserve(),
        pin = await repository.beginPin(identity);
      await expect(
        pool.query(
          "UPDATE catalog_operation_pins SET state='settled',settled_at=now(),outcome=NULL WHERE pin_id=$1",
          [pin.pinId],
        ),
      ).rejects.toMatchObject({ code: '23514' });
      await expect(
        pool.query(
          'UPDATE catalog_operation_pins SET generation=generation+1 WHERE pin_id=$1',
          [pin.pinId],
        ),
      ).rejects.toMatchObject({ code: '23503' });
      expect(
        await repository.read(identity.ownerId, identity.domain),
      ).toMatchObject({ pendingPins: 1 });
    });
  },
);
