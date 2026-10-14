import {
  CatalogOperationError,
  PgCatalogOperationRepository,
  RedisTaskRepository,
  TaskRegistryError,
  type CatalogOperationIdentity,
  type TaskRedisPort,
} from '@asin-monitor/db';
import { EventEmitter } from 'node:events';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import type { AuthPrincipal } from '../src/auth/auth.types';
import { ApplicationCatalogOperations } from '../src/catalog/catalog-operation.service';
import type { ApplicationDatabasePools } from '../src/database/database.service';
import type { AppLogger } from '../src/logger/app-logger.service';
import { taskAuthFixture } from './helpers/task-query-fixtures';

type Domain = CatalogOperationIdentity['domain'];
type Fault = 'none' | 'bind-borrow' | 'bind-sql' | 'bind-commit-ack';
interface Slot {
  owner_id: string;
  domain: Domain;
  generation: string;
  operation_id: string | null;
  kind: string | null;
  state: 'idle' | 'open' | 'closed';
  expected_task_id: string | null;
  task_id: string | null;
  task_type: string | null;
  task_sub_type: string | null;
  task_created_at: string | null;
  terminal: unknown;
}

// Only SQL/Redis transport is synthetic. The actual application execute,
// PgCatalogOperationRepository, bounded Drizzle transaction, preparation
// callback, RedisTaskRepository validation and EVAL ordering remain in use.
// This does NOT prove native PostgreSQL lock/rollback semantics: that gate is
// in catalog-submission-binding.integration.test.ts.
function fixture(domain: Domain, fault: Fault = 'none', evalResult = 1) {
  const auth = taskAuthFixture();
  const principal: AuthPrincipal = {
    userId: auth.user.id,
    sessionId: auth.session.id,
    user: { ...auth.user, status: 'ACTIVE', forcePasswordChange: false },
  };
  let committed: Slot = {
    owner_id: principal.userId,
    domain,
    generation: '0',
    operation_id: null,
    kind: null,
    state: 'idle',
    expected_task_id: null,
    task_id: null,
    task_type: null,
    task_sub_type: null,
    task_created_at: null,
    terminal: null,
  };
  const statements: { connection: number; text: string }[] = [];
  let connection = 0;
  const pool = {
    connect: vi.fn(async () => {
      const id = ++connection;
      if (id === 2 && fault === 'bind-borrow')
        throw new Error('synthetic bind connection refused');
      let transaction = structuredClone(committed);
      const query = vi.fn(
        async (
          raw: string | { text: string; rowMode?: string },
          values: unknown[] = [],
        ) => {
          const text = typeof raw === 'string' ? raw : raw.text;
          statements.push({ connection: id, text });
          if (text === 'BEGIN') transaction = structuredClone(committed);
          if (text === 'COMMIT') {
            committed = structuredClone(transaction);
            if (id === 2 && fault === 'bind-commit-ack')
              throw new Error('synthetic bind committed but ACK lost');
          }
          if (/from "users"/i.test(text))
            return {
              rows: [[principal.userId, 'ACTIVE', null, false, null]],
            };
          if (/from "sessions"/i.test(text))
            return {
              rows: [
                [
                  principal.sessionId,
                  principal.userId,
                  null,
                  null,
                  'ACTIVE',
                  false,
                  '2026-10-08 08:00:00',
                  '2026-10-08 08:00:00',
                  '2099-01-01 08:00:00',
                ],
              ],
            };
          if (/from "user_roles"/i.test(text))
            return { rows: [['asin:write']] };
          if (/SELECT[\s\S]*FROM catalog_operation_slots/.test(text))
            return { rows: [structuredClone(transaction)] };
          if (/SELECT count\(\*\)[\s\S]*catalog_operation_pins/.test(text))
            return { rows: [{ pending: '0', uncertain: '0' }] };
          if (/UPDATE catalog_operation_slots SET generation=/.test(text)) {
            transaction = {
              ...transaction,
              generation: String(values[0]),
              operation_id: String(values[1]),
              kind: String(values[2]),
              state: 'open',
              expected_task_id: values[3] === null ? null : String(values[3]),
              task_id: null,
              task_type: null,
              task_sub_type: null,
              task_created_at: null,
              terminal: null,
            };
          }
          if (
            /UPDATE catalog_operation_slots SET expected_task_id=/.test(text)
          ) {
            if (id === 2 && fault === 'bind-sql')
              throw new Error('synthetic bind SQL failed before COMMIT');
            transaction = {
              ...transaction,
              expected_task_id: String(values[0]),
              task_id: String(values[1]),
              task_type: String(values[2]),
              task_sub_type: String(values[3]),
              task_created_at: String(values[4]),
            };
          }
          if (/UPDATE catalog_operation_slots SET state=CASE/.test(text)) {
            transaction.state = 'closed';
            transaction.terminal ??=
              values[0] === null ? null : JSON.parse(String(values[0]));
          }
          if (/UPDATE catalog_operation_slots SET state='idle'/.test(text))
            transaction = {
              ...transaction,
              state: 'idle',
              operation_id: null,
              kind: null,
              expected_task_id: null,
              task_id: null,
              task_type: null,
              task_sub_type: null,
              task_created_at: null,
              terminal: null,
            };
          return { rows: [] };
        },
      );
      return Object.assign(new EventEmitter(), { query, release: vi.fn() });
    }),
  };
  const evalCommand = vi.fn(async (..._args: unknown[]) => {
    expect(committed.task_id).not.toBeNull();
    return evalResult;
  });
  const redis = {
    eval: evalCommand,
    get: vi.fn(async () => null),
    zrevrange: vi.fn(async () => []),
    mget: vi.fn(async () => []),
  } as unknown as TaskRedisPort;
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const service = new ApplicationCatalogOperations(
    { primaryPool: pool as unknown as Pool } as ApplicationDatabasePools,
    logger as unknown as AppLogger,
  );
  const repository = new PgCatalogOperationRepository(pool as unknown as Pool);
  const tasks = new RedisTaskRepository(
    redis,
    {
      BULL_PREFIX: 'synthetic-bind-224',
      TASK_META_TTL_SECONDS: 604800,
      TASK_USER_MAX_ITEMS: 200,
    },
    () => new Date('2026-10-09T00:00:00.000Z'),
  );
  const input = {
    taskId: '22400000-0000-4000-8000-000000000088',
    userId: principal.userId,
    taskType: 'batch-delete' as const,
    taskSubType:
      domain === 'asin'
        ? 'variant-group-delete'
        : 'competitor-variant-group-delete',
  };
  const enqueue = vi.fn(async () => undefined);
  const submit = () =>
    service.execute(
      principal,
      domain,
      'batch-delete',
      'asin:write',
      async (submission) => {
        submission.retain();
        const task = await tasks.create(input, (prepared) =>
          submission.bindTask(prepared),
        );
        await enqueue();
        return task;
      },
    );
  return {
    service,
    repository,
    principal,
    submit,
    input,
    enqueue,
    evalCommand,
    statements,
    logger,
    slot: () => structuredClone(committed),
    next: () =>
      service.execute(principal, domain, 'write', 'asin:write', async () => 17),
  };
}

describe('retained producer preparation / actual application and task repository', () => {
  it.each(
    (['asin', 'competitor'] as const).flatMap((domain) =>
      (['bind-borrow', 'bind-sql'] as const).map((fault) => ({
        domain,
        fault,
      })),
    ),
  )(
    'releases only its definitely unbound $domain reservation after $fault, with zero Redis EVAL calls and a healthy next admission',
    async ({ domain, fault }) => {
      const f = fixture(domain, fault);
      const error = await f.submit().catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      expect(f.evalCommand).not.toHaveBeenCalled();
      expect(f.enqueue).not.toHaveBeenCalled();
      expect(
        f.statements.some((statement) => statement.text === 'COMMIT'),
      ).toBe(true);
      expect(f.slot()).toMatchObject({
        domain,
        state: 'idle',
        task_id: null,
        operation_id: null,
        terminal: null,
      });
      expect(await f.next()).toBe(17);
      expect(f.slot()).toMatchObject({ state: 'idle', generation: '2' });
    },
  );

  it.each(['asin', 'competitor'] as const)(
    'retains a genuinely committed %s binding when its COMMIT ACK is lost, despite zero Redis EVAL calls',
    async (domain) => {
      const f = fixture(domain, 'bind-commit-ack');
      await expect(f.submit()).rejects.toThrow(
        'synthetic bind committed but ACK lost',
      );
      expect(f.evalCommand).not.toHaveBeenCalled();
      expect(f.enqueue).not.toHaveBeenCalled();
      const before = f.slot();
      expect(before).toMatchObject({
        state: 'open',
        task_id: f.input.taskId,
        terminal: null,
      });
      await expect(f.next()).rejects.toMatchObject({ status: 409 });
      expect(f.slot()).toEqual(before);
      expect(
        f.statements.some(({ text }) =>
          /UPDATE catalog_operation_slots SET state='idle'/.test(text),
        ),
      ).toBe(false);
    },
  );

  it.each(['asin', 'competitor'] as const)(
    'retains the confirmed %s binding when Redis EVAL actually returns zero (TASK_EXISTS), without treating zero calls as a zero return',
    async (domain) => {
      const f = fixture(domain, 'none', 0);
      await expect(f.submit()).rejects.toBeInstanceOf(TaskRegistryError);
      expect(f.evalCommand).toHaveBeenCalledTimes(1);
      expect(f.enqueue).not.toHaveBeenCalled();
      const before = f.slot();
      expect(before).toMatchObject({
        state: 'open',
        task_id: f.input.taskId,
        terminal: null,
      });
      await expect(f.next()).rejects.toMatchObject({ status: 409 });
      expect(f.slot()).toEqual(before);
    },
  );

  it.each(['asin', 'competitor'] as const)(
    'preserves the confirmed %s binding after an actually issued Redis EVAL loses its ACK',
    async (domain) => {
      const f = fixture(domain);
      f.evalCommand.mockImplementationOnce(async (..._args: unknown[]) => {
        expect(f.slot().task_id).toBe(f.input.taskId);
        throw new Error('synthetic Redis EVAL ACK lost');
      });
      await expect(f.submit()).rejects.toThrow('synthetic Redis EVAL ACK lost');
      expect(f.evalCommand).toHaveBeenCalledTimes(1);
      expect(f.enqueue).not.toHaveBeenCalled();
      const before = f.slot();
      await expect(f.next()).rejects.toMatchObject({ status: 409 });
      expect(f.slot()).toEqual(before);
    },
  );

  it.each(['asin', 'competitor'] as const)(
    'keeps ordinary %s synchronous settlement and later admission healthy',
    async (domain) => {
      const f = fixture(domain);
      expect(await f.next()).toBe(17);
      expect(f.slot()).toMatchObject({ state: 'idle', generation: '1' });
      expect(await f.next()).toBe(17);
      expect(f.slot()).toMatchObject({ state: 'idle', generation: '2' });
      expect(f.evalCommand).not.toHaveBeenCalled();
      expect(f.logger.warn).not.toHaveBeenCalled();
    },
  );

  it('uses the actual PG close proof validator to reject synchronous release of an already bound identity', async () => {
    const f = fixture('asin');
    const task = await f.submit();
    expect(task.taskId).toBe(f.input.taskId);
    expect(f.evalCommand).toHaveBeenCalledTimes(1);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    const before = f.slot();
    const identity = await f.repository.findByTask({
      taskId: task.taskId,
      userId: task.userId,
      taskType: f.input.taskType,
      taskSubType: task.taskSubType!,
      createdAt: task.createdAt,
    });
    await expect(
      f.repository.close(identity, { status: 'failed', source: 'sync' }),
    ).rejects.toBeInstanceOf(CatalogOperationError);
    expect(f.slot()).toEqual(before);
    expect(await f.repository.release(identity)).toBe(false);
  });
});
