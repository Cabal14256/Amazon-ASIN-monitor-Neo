import {
  PgCatalogOperationRepository,
  RedisTaskRepository,
  type TaskRedisPort,
} from '@asin-monitor/db';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthPrincipal } from '../src/auth/auth.types';
import { ApplicationCatalogOperations } from '../src/catalog/catalog-operation.service';
import type { ApplicationDatabasePools } from '../src/database/database.service';
import type { AppLogger } from '../src/logger/app-logger.service';
import { asinWriteApp } from './helpers/asin-write-app';
import { taskAuthFixture } from './helpers/task-query-fixtures';

type Domain = 'asin' | 'competitor';
type Fault = 'borrow' | 'sql' | 'commit-ack' | 'held-commit';
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

// Native SQL/locks/COMMIT/rollback; only the failing driver acknowledgement and
// Redis commands are synthetic. Does not claim native Redis/BullMQ coverage.
describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'catalog producer preparation / actual PostgreSQL binding and cleanup serialization',
  () => {
    let app: Awaited<ReturnType<typeof asinWriteApp>> | undefined;
    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    async function fixture(domain: Domain, fault: Fault) {
      const f = await asinWriteApp();
      app = f;
      const userId = randomUUID(),
        sessionId = randomUUID();
      f.userIds.add(userId);
      await f.pools.primaryPool.query(
        'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$1,$2,false)',
        [userId, 'synthetic-unused-hash'],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO user_roles(user_id,role_id) VALUES($1,'writer-71')",
        [userId],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,'2099-01-01 08:00:00')",
        [sessionId, userId],
      );
      const principal: AuthPrincipal = {
        userId,
        sessionId,
        user: {
          ...taskAuthFixture().user,
          id: userId,
          status: 'ACTIVE',
          forcePasswordChange: false,
        },
      };
      const releaseCommit = deferred<void>(),
        commitHeld = deferred<void>(),
        cleanupStarted = deferred<void>(),
        physicalFinished = deferred<void>();
      let connections = 0,
        bindPid = 0,
        cleanupPid = 0,
        heldClient: PoolClient | undefined,
        deferredDiscard = false,
        commitWasHeld = false;
      const queryCalls: { connection: number; text: string }[] = [];
      const wrappedPool = {
        connect: async () => {
          const connection = ++connections;
          if (connection === 2 && fault === 'borrow')
            throw new Error('synthetic bind acquisition failed');
          const client = await f.pools.primaryPool.connect();
          const pid = Number(
            (await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid,
          );
          if (connection === 2) bindPid = pid;
          if (connection === 3) cleanupPid = pid;
          const originalQuery = client.query.bind(client);
          const originalRelease = client.release.bind(client);
          const query = async (
            raw: string | { text: string },
            values?: unknown[],
          ) => {
            const text = typeof raw === 'string' ? raw : raw.text;
            queryCalls.push({ connection, text });
            if (
              connection === 3 &&
              /SELECT[\s\S]*catalog_operation_slots[\s\S]*FOR UPDATE/.test(text)
            )
              cleanupStarted.resolve();
            if (
              connection === 2 &&
              fault === 'sql' &&
              /UPDATE catalog_operation_slots SET expected_task_id=/.test(text)
            )
              return originalQuery('SELECT 1 / 0');
            if (connection === 2 && text === 'COMMIT') {
              if (fault === 'held-commit') {
                // The UPDATE is physically complete but its transaction still
                // owns the real slot lock. Delay physical discard as a transport
                // seam so a timed-out client cannot pretend rollback settled.
                heldClient = client;
                commitWasHeld = true;
                commitHeld.resolve();
                await releaseCommit.promise;
              }
              try {
                const result = await originalQuery(raw, values);
                if (fault === 'commit-ack')
                  throw new Error('synthetic physical COMMIT ACK lost');
                return result;
              } finally {
                physicalFinished.resolve();
                if (deferredDiscard) originalRelease(true);
              }
            }
            return originalQuery(raw, values);
          };
          return new Proxy(client, {
            get(target, key) {
              if (key === 'query') return query;
              if (key === 'release')
                return (discard?: boolean) => {
                  if (
                    fault === 'held-commit' &&
                    connection === 2 &&
                    heldClient &&
                    discard
                  ) {
                    deferredDiscard = true;
                    return;
                  }
                  originalRelease(discard);
                };
              const value = Reflect.get(target, key, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });
        },
      } as unknown as Pool;
      const operations = new ApplicationCatalogOperations(
        { primaryPool: wrappedPool } as unknown as ApplicationDatabasePools,
        f.logger as unknown as AppLogger,
      );
      const evalCommand = vi.fn(async (..._args: unknown[]) => 1);
      const tasks = new RedisTaskRepository(
        {
          eval: evalCommand,
          get: vi.fn(async () => null),
          zrevrange: vi.fn(async () => []),
          mget: vi.fn(async () => []),
        } as unknown as TaskRedisPort,
        {
          BULL_PREFIX: 'synthetic-bind-native-224',
          TASK_META_TTL_SECONDS: 604800,
          TASK_USER_MAX_ITEMS: 200,
        },
        () => new Date('2026-10-09T00:00:00.000Z'),
      );
      const taskId = randomUUID();
      const submission = operations.execute(
        principal,
        domain,
        'batch-delete',
        'asin:write',
        async (catalog) => {
          catalog.retain();
          return tasks.create(
            {
              taskId,
              userId,
              taskType: 'batch-delete',
              taskSubType:
                domain === 'asin'
                  ? 'variant-group-delete'
                  : 'competitor-variant-group-delete',
            },
            (prepared) => catalog.bindTask(prepared),
          );
        },
      );
      // Attach immediately so deliberately lost acknowledgements are not unhandled.
      const outcome = submission.then(
        (value) => ({ value, error: null as unknown }),
        (error: unknown) => ({ value: null, error }),
      );
      const slot = async () =>
        (
          await f.pools.primaryPool.query(
            'SELECT * FROM catalog_operation_slots WHERE owner_id=$1 AND domain=$2',
            [userId, domain],
          )
        ).rows[0];
      const pins = async () =>
        (
          await f.pools.primaryPool.query(
            'SELECT * FROM catalog_operation_pins WHERE owner_id=$1 AND domain=$2 ORDER BY pin_id',
            [userId, domain],
          )
        ).rows;
      return {
        f,
        domain,
        userId,
        taskId,
        operations,
        principal,
        outcome,
        slot,
        pins,
        evalCommand,
        queryCalls,
        commitHeld,
        cleanupStarted,
        releaseCommit,
        physicalFinished,
        bindPid: () => bindPid,
        cleanupPid: () => cleanupPid,
        commitWasHeld: () => commitWasHeld,
      };
    }

    it.each(
      (['asin', 'competitor'] as const).flatMap((domain) =>
        (['borrow', 'sql'] as const).map((fault) => ({ domain, fault })),
      ),
    )(
      'releases the exact unbound $domain slot after real PG admission and $fault failure, zero EVAL calls, and admits a later operation',
      async ({ domain, fault }) => {
        const f = await fixture(domain, fault);
        const result = await f.outcome;
        expect(result.error).toBeInstanceOf(Error);
        expect(f.evalCommand).not.toHaveBeenCalled();
        expect(await f.slot()).toMatchObject({
          state: 'idle',
          operation_id: null,
          task_id: null,
          terminal: null,
        });
        expect(await f.pins()).toEqual([]);
        expect(
          await f.operations.execute(
            f.principal,
            domain,
            'write',
            'asin:write',
            async () => 17,
          ),
        ).toBe(17);
        expect(await f.slot()).toMatchObject({
          state: 'idle',
          generation: '2',
        });
      },
    );

    it.each(['asin', 'competitor'] as const)(
      'retains the exact %s binding after actual COMMIT with a lost driver ACK, without creating a Redis task',
      async (domain) => {
        const f = await fixture(domain, 'commit-ack');
        expect((await f.outcome).error).toBeInstanceOf(Error);
        expect(f.evalCommand).not.toHaveBeenCalled();
        const before = await f.slot();
        expect(before).toMatchObject({
          state: 'open',
          task_id: f.taskId,
          terminal: null,
        });
        expect(await f.pins()).toEqual([]);
        await expect(
          f.operations.execute(
            f.principal,
            domain,
            'write',
            'asin:write',
            async () => 17,
          ),
        ).rejects.toMatchObject({ status: 409 });
        expect(await f.slot()).toEqual(before);
      },
    );

    it.each(['asin', 'competitor'] as const)(
      'serializes %s cleanup behind an actually held bind transaction, and does not release its later committed binding',
      async (domain) => {
        const f = await fixture(domain, 'held-commit');
        try {
          await Promise.race([
            f.commitHeld.promise,
            f.outcome.then(() => {
              throw new Error(
                'Submission ended before physical bind COMMIT was held',
              );
            }),
          ]);
          expect(f.bindPid()).toBeGreaterThan(0);
          expect(
            (
              await f.f.pools.primaryPool.query(
                "SELECT count(*)::integer AS count FROM pg_locks WHERE pid=$1 AND relation='catalog_operation_slots'::regclass AND mode='RowExclusiveLock' AND granted",
                [f.bindPid()],
              )
            ).rows[0].count,
          ).toBe(1);
          // The existing 2000 ms transaction deadline must elapse naturally. A
          // healthy repair then opens a new transaction to attempt sync cleanup.
          const cleanupObserved = await Promise.race([
            f.cleanupStarted.promise.then(() => true),
            f.outcome.then(() => false),
          ]);
          expect(cleanupObserved).toBe(true);
          await expect
            .poll(
              async () =>
                (
                  await f.f.pools.primaryPool.query(
                    'SELECT count(*)::integer AS count FROM pg_locks WHERE pid=$1 AND NOT granted',
                    [f.cleanupPid()],
                  )
                ).rows[0].count,
              { timeout: 1000, interval: 10 },
            )
            .toBeGreaterThan(0);
          expect(f.evalCommand).not.toHaveBeenCalled();
          expect(await f.slot()).toMatchObject({
            state: 'open',
            task_id: null,
          });
          f.releaseCommit.resolve();
          await f.physicalFinished.promise;
          expect((await f.outcome).error).toBeInstanceOf(Error);
          const before = await f.slot();
          expect(before).toMatchObject({
            state: 'open',
            task_id: f.taskId,
            terminal: null,
          });
          expect(await f.pins()).toEqual([]);
          expect(f.evalCommand).not.toHaveBeenCalled();
          const repository = new PgCatalogOperationRepository(
            f.f.pools.primaryPool,
          );
          expect(await repository.read(f.userId, domain)).toMatchObject({
            state: 'open',
            pendingPins: 0,
            uncertainPins: 0,
            task: { taskId: f.taskId },
          });
          await expect(
            f.operations.execute(
              f.principal,
              domain,
              'write',
              'asin:write',
              async () => 17,
            ),
          ).rejects.toMatchObject({ status: 409 });
          expect(await f.slot()).toEqual(before);
        } finally {
          f.releaseCommit.resolve();
          await f.outcome;
          if (f.commitWasHeld()) await f.physicalFinished.promise;
        }
      },
    );
  },
);
