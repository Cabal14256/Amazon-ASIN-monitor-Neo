import { taskInfoResultSchema } from '@asin-monitor/contracts';
import {
  PgCatalogOperationRepository,
  transitionTask,
  type TaskState,
} from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApplicationCatalogOperations } from '../src/catalog/catalog-operation.service';
import type { ApplicationDatabasePools } from '../src/database/database.service';
import type { AppLogger } from '../src/logger/app-logger.service';
import { TaskQueryModule } from '../src/tasks/task-query.module';
import {
  TaskQueryRuntime,
  type TaskCancellationPort,
} from '../src/tasks/task-query.runtime';
import { sessionApp } from './helpers/session-app';
import {
  taskAuthFixture,
  taskFixture,
  taskSessionId,
  taskUserId,
} from './helpers/task-query-fixtures';

async function settlementHarness(count = 1) {
  const auth = taskAuthFixture();
  const tasks = new Map<string, TaskState>();
  const queued = new Set<string>();
  for (let index = 0; index < count; index++) {
    const task = taskFixture({
      taskId: randomUUID(),
      taskType: 'batch-delete',
      taskSubType: 'variant-group-delete',
    });
    tasks.set(task.taskId, task);
    queued.add(task.taskId);
  }
  const find = vi
    .spyOn(PgCatalogOperationRepository.prototype, 'findByTask')
    .mockImplementation(async (task) => ({
      ownerId: task.userId,
      domain: 'asin',
      kind: 'batch-delete',
      operationId: task.taskId,
      generation: '1',
    }));
  const close = vi
    .spyOn(PgCatalogOperationRepository.prototype, 'close')
    .mockResolvedValue(undefined);
  const release = vi
    .spyOn(PgCatalogOperationRepository.prototype, 'release')
    .mockResolvedValue(true);
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const catalog = new ApplicationCatalogOperations(
    { primaryPool: {} } as unknown as ApplicationDatabasePools,
    logger as unknown as AppLogger,
  );
  const port: TaskCancellationPort = {
    store: {
      read: vi.fn(async (id) => tasks.get(id) ?? null),
      mutate: vi.fn(async (id, change) => {
        const task = tasks.get(id);
        if (!task) return null;
        const next = transitionTask(task, change, new Date());
        tasks.set(id, next);
        return next;
      }),
    },
    cancelJob: vi.fn(async (task) => {
      expect(queued.delete(task.taskId)).toBe(true);
      return 'removed' as const;
    }),
  };
  const app = await sessionApp(
    auth.repository,
    {},
    (builder) =>
      builder
        .overrideProvider(TaskQueryRuntime)
        .useValue({ openCancellation: vi.fn(() => port) })
        .overrideProvider(ApplicationCatalogOperations)
        .useValue(catalog),
    [TaskQueryModule],
  );
  const headers = {
    authorization: `Bearer ${jwt.sign(
      { userId: taskUserId, sessionId: taskSessionId },
      app.env.JWT_SECRET,
      { expiresIn: '1h' },
    )}`,
  };
  return {
    tasks,
    queued,
    ids: [...tasks.keys()],
    port,
    find,
    close,
    release,
    catalog,
    cancel: (id: string) =>
      app.http.inject({
        method: 'POST',
        url: `/api/v1/tasks/${id}/cancel`,
        headers,
      }),
    dispose: () => app.app.close(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('removed cancellation / bounded physical settlement HTTP', () => {
  it('retains confirmed physical removals even when their queue ACK arrives after the logical deadline', async () => {
    const h = await settlementHarness(9);
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.mocked(h.port.cancelJob).mockImplementation(async (task) => {
      expect(h.queued.delete(task.taskId)).toBe(true);
      clock = 3001;
      return 'removed' as const;
    });
    try {
      for (const id of h.ids.slice(0, 8)) {
        clock = 0;
        expect((await h.cancel(id)).statusCode).toBe(500);
        expect(h.tasks.get(id)?.status).toBe('pending');
      }
      clock = 0;
      expect((await h.cancel(h.ids[8])).statusCode).toBe(429);
      expect(h.queued.has(h.ids[8])).toBe(true);
      expect(h.port.cancelJob).toHaveBeenCalledTimes(8);
      expect(h.port.store.mutate).not.toHaveBeenCalled();
      expect(h.find).not.toHaveBeenCalled();
      expect(h.close).not.toHaveBeenCalled();
      expect(h.release).not.toHaveBeenCalled();
    } finally {
      await h.dispose();
    }
  });
  it.each(['before-CAS', 'after-CAS-ACK'] as const)(
    'retains actual removal proofs after %s failure and rejects the ninth queue mutation',
    async (phase) => {
      const h = await settlementHarness(9);
      const mutate = vi.mocked(h.port.store.mutate).getMockImplementation()!;
      vi.mocked(h.port.store.mutate).mockImplementation(async (...args) => {
        if (phase === 'after-CAS-ACK') await mutate(...args);
        throw new Error('synthetic metadata acknowledgement failure');
      });
      try {
        for (const id of h.ids.slice(0, 8))
          expect((await h.cancel(id)).statusCode).toBe(500);
        expect(h.port.cancelJob).toHaveBeenCalledTimes(8);
        expect(h.queued.size).toBe(1);
        expect(h.find).not.toHaveBeenCalled();
        expect(h.close).not.toHaveBeenCalled();
        const original = { ...h.tasks.get(h.ids[8])! };
        expect((await h.cancel(h.ids[8])).statusCode).toBe(429);
        expect(h.queued.has(h.ids[8])).toBe(true);
        expect(h.tasks.get(h.ids[8])).toEqual(original);
        expect(h.port.cancelJob).toHaveBeenCalledTimes(8);
        expect(h.port.store.mutate).toHaveBeenCalledTimes(8);
        if (phase === 'after-CAS-ACK') {
          expect(h.tasks.get(h.ids[0])?.status).toBe('cancelled');
          const settled = await h.cancel(h.ids[0]);
          expect(settled.statusCode).toBe(200);
          expect(taskInfoResultSchema.parse(settled.json()).data?.status).toBe(
            'cancelled',
          );
          expect(h.release).toHaveBeenCalledTimes(1);
          expect(h.port.cancelJob).toHaveBeenCalledTimes(8);
          expect(h.port.store.mutate).toHaveBeenCalledTimes(8);
        }
      } finally {
        await h.dispose();
      }
    },
  );
  it('rejects the ninth request before queue removal while eight HTTP requests have ended but PostgreSQL settlement is still held', async () => {
    const auth = taskAuthFixture();
    const tasks = new Map<string, TaskState>();
    const queued = new Set<string>();
    for (let index = 0; index < 9; index++) {
      const task = taskFixture({
        taskId: randomUUID(),
        taskType: 'batch-delete',
        taskSubType: 'variant-group-delete',
      });
      tasks.set(task.taskId, task);
      queued.add(task.taskId);
    }
    const ids = [...tasks.keys()];
    const releases: (() => void)[] = [];
    vi.spyOn(
      PgCatalogOperationRepository.prototype,
      'findByTask',
    ).mockImplementation(async (task) => ({
      ownerId: task.userId,
      domain: 'asin',
      kind: 'batch-delete',
      operationId: task.taskId,
      generation: '1',
    }));
    const close = vi
      .spyOn(PgCatalogOperationRepository.prototype, 'close')
      .mockImplementation(async () => {
        await new Promise<void>((resolve) => releases.push(resolve));
      });
    const release = vi
      .spyOn(PgCatalogOperationRepository.prototype, 'release')
      .mockResolvedValue(true);
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const catalog = new ApplicationCatalogOperations(
      { primaryPool: {} } as unknown as ApplicationDatabasePools,
      logger as unknown as AppLogger,
    );
    const port: TaskCancellationPort = {
      store: {
        read: vi.fn(async (id) => tasks.get(id) ?? null),
        mutate: vi.fn(async (id, change) => {
          const task = tasks.get(id);
          if (!task) return null;
          const next = transitionTask(task, change, new Date());
          tasks.set(id, next);
          return next;
        }),
      },
      cancelJob: vi.fn(async (task) => {
        expect(queued.delete(task.taskId)).toBe(true);
        return 'removed' as const;
      }),
    };
    const app = await sessionApp(
      auth.repository,
      {},
      (builder) =>
        builder
          .overrideProvider(TaskQueryRuntime)
          .useValue({ openCancellation: vi.fn(() => port) })
          .overrideProvider(ApplicationCatalogOperations)
          .useValue(catalog),
      [TaskQueryModule],
    );
    const headers = {
      authorization: `Bearer ${jwt.sign(
        { userId: taskUserId, sessionId: taskSessionId },
        app.env.JWT_SECRET,
        { expiresIn: '1h' },
      )}`,
    };
    const cancel = (id: string) =>
      app.http.inject({
        method: 'POST',
        url: `/api/v1/tasks/${id}/cancel`,
        headers,
      });
    let pending: Promise<Awaited<ReturnType<typeof cancel>>>[] = [];
    try {
      vi.useFakeTimers();
      pending = ids.slice(0, 8).map((id) => Promise.resolve(cancel(id)));
      await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(8));
      await vi.advanceTimersByTimeAsync(3001);
      const first = await Promise.all(pending);
      for (const response of first) {
        expect(response.statusCode).toBe(200);
        expect(taskInfoResultSchema.parse(response.json()).data?.status).toBe(
          'cancelled',
        );
      }
      expect(release).not.toHaveBeenCalled();
      const original = { ...tasks.get(ids[8])! };
      const rejected = await cancel(ids[8]);
      expect(rejected.statusCode).toBe(429);
      expect(queued.has(ids[8])).toBe(true);
      expect(tasks.get(ids[8])).toEqual(original);
      expect(port.cancelJob).toHaveBeenCalledTimes(8);
      expect(port.store.mutate).toHaveBeenCalledTimes(8);
      releases[0]();
      await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
      close.mockResolvedValue(undefined);
      const retry = await cancel(ids[8]);
      expect(retry.statusCode).toBe(200);
      expect(taskInfoResultSchema.parse(retry.json()).data?.status).toBe(
        'cancelled',
      );
      expect(queued.has(ids[8])).toBe(false);
      expect(release).toHaveBeenCalledTimes(2);
      expect(port.cancelJob).toHaveBeenCalledTimes(9);
    } finally {
      releases.forEach((finish) => finish());
      await vi.advanceTimersByTimeAsync(3001);
      await Promise.allSettled(pending);
      vi.useRealTimers();
      await app.app.close();
    }
  }, 15_000);
  it('retains all eight failed settlements after three attempts and retries only the exact cancelled record without another queue removal or metadata CAS', async () => {
    const h = await settlementHarness(9);
    h.close.mockRejectedValue(
      new Error('synthetic PostgreSQL acknowledgement unavailable'),
    );
    try {
      for (const id of h.ids.slice(0, 8)) {
        const response = await h.cancel(id);
        expect(response.statusCode).toBe(200);
        expect(taskInfoResultSchema.parse(response.json()).data?.status).toBe(
          'cancelled',
        );
      }
      expect(h.close).toHaveBeenCalledTimes(24);
      expect(h.find).toHaveBeenCalledTimes(8);
      expect(h.release).not.toHaveBeenCalled();
      const blocked = { ...h.tasks.get(h.ids[8])! };
      expect((await h.cancel(h.ids[8])).statusCode).toBe(429);
      expect(h.queued.has(h.ids[8])).toBe(true);
      expect(h.tasks.get(h.ids[8])).toEqual(blocked);
      expect(h.port.cancelJob).toHaveBeenCalledTimes(8);
      expect(h.port.store.mutate).toHaveBeenCalledTimes(8);
      const cancelled = { ...h.tasks.get(h.ids[0])! };
      h.close.mockResolvedValue(undefined);
      const retry = await h.cancel(h.ids[0]);
      expect(retry.statusCode).toBe(200);
      expect(taskInfoResultSchema.parse(retry.json()).data).toMatchObject({
        taskId: cancelled.taskId,
        status: 'cancelled',
        updatedAt: cancelled.updatedAt,
        cancelledAt: cancelled.cancelledAt,
      });
      expect(h.tasks.get(h.ids[0])).toEqual(cancelled);
      expect(h.port.cancelJob).toHaveBeenCalledTimes(8);
      expect(h.port.store.mutate).toHaveBeenCalledTimes(8);
      expect(h.close).toHaveBeenCalledTimes(25);
      expect(h.release).toHaveBeenCalledTimes(1);
      // A completed settlement no longer authorizes arbitrary terminal replay.
      expect((await h.cancel(h.ids[0])).statusCode).toBe(400);
      expect((await h.cancel(h.ids[8])).statusCode).toBe(200);
      expect(h.port.cancelJob).toHaveBeenCalledTimes(9);
      expect(h.port.store.mutate).toHaveBeenCalledTimes(9);
    } finally {
      await h.dispose();
    }
  });
  it('retries the original physical identity after close committed but its acknowledgement was lost', async () => {
    const h = await settlementHarness();
    const terminal = new Map<string, unknown>();
    h.close.mockImplementation(async (identity, proof) => {
      const previous = terminal.get(identity.operationId);
      if (previous) expect(proof).toEqual(previous);
      terminal.set(identity.operationId, proof);
      if (!previous) throw new Error('synthetic ACK lost after actual close');
    });
    try {
      const result = await h.cancel(h.ids[0]);
      expect(result.statusCode).toBe(200);
      expect(taskInfoResultSchema.parse(result.json()).data?.status).toBe(
        'cancelled',
      );
      expect(h.find).toHaveBeenCalledTimes(1);
      expect(h.close).toHaveBeenCalledTimes(2);
      expect(h.close.mock.calls[1]).toEqual(h.close.mock.calls[0]);
      expect(h.release).toHaveBeenCalledExactlyOnceWith(
        h.close.mock.calls[0][0],
      );
      expect(h.port.cancelJob).toHaveBeenCalledTimes(1);
      expect(h.port.store.mutate).toHaveBeenCalledTimes(1);
    } finally {
      await h.dispose();
    }
  });
  it('keeps non-catalog cancellation available while all eight catalog settlement leases remain unconfirmed', async () => {
    const h = await settlementHarness(10);
    h.close.mockRejectedValue(new Error('synthetic PostgreSQL unavailable'));
    try {
      for (const id of h.ids.slice(0, 8))
        expect((await h.cancel(id)).statusCode).toBe(200);
      h.tasks.set(h.ids[8], {
        ...h.tasks.get(h.ids[8])!,
        taskType: 'export',
        taskSubType: 'asin',
      });
      expect((await h.cancel(h.ids[8])).statusCode).toBe(200);
      expect(h.find).toHaveBeenCalledTimes(8);
      expect(h.close).toHaveBeenCalledTimes(24);
      expect(h.port.cancelJob).toHaveBeenCalledTimes(9);
      expect(h.port.store.mutate).toHaveBeenCalledTimes(9);
      expect((await h.cancel(h.ids[9])).statusCode).toBe(429);
      expect(h.queued.has(h.ids[9])).toBe(true);
      expect(h.tasks.get(h.ids[9])?.status).toBe('pending');
      expect(h.port.cancelJob).toHaveBeenCalledTimes(9);
    } finally {
      await h.dispose();
    }
  });
  it.each([
    ['taskId', 400],
    ['userId', 403],
    ['taskType', 400],
    ['taskSubType', 400],
    ['createdAt', 400],
    ['completed', 400],
    ['failed', 400],
  ] as const)(
    'does not retry a removed settlement after %s changes',
    async (field, status) => {
      const h = await settlementHarness();
      h.close.mockRejectedValue(new Error('synthetic PostgreSQL unavailable'));
      try {
        expect((await h.cancel(h.ids[0])).statusCode).toBe(200);
        expect(h.close).toHaveBeenCalledTimes(3);
        const original = h.tasks.get(h.ids[0])!;
        const replaced = { ...original };
        if (field === 'taskId') replaced.taskId = randomUUID();
        else if (field === 'userId') replaced.userId = 'foreign-owner';
        else if (field === 'taskType') replaced.taskType = 'import';
        else if (field === 'taskSubType')
          replaced.taskSubType = 'competitor-variant-group-delete';
        else if (field === 'createdAt')
          replaced.createdAt = '2099-01-01T00:00:00.000Z';
        else replaced.status = field;
        h.tasks.set(h.ids[0], replaced);
        const response = await h.cancel(h.ids[0]);
        expect(response.statusCode).toBe(status);
        expect(h.close).toHaveBeenCalledTimes(3);
        expect(h.find).toHaveBeenCalledTimes(1);
        expect(h.release).not.toHaveBeenCalled();
        expect(h.port.cancelJob).toHaveBeenCalledTimes(1);
        expect(h.port.store.mutate).toHaveBeenCalledTimes(1);
        expect(h.tasks.get(h.ids[0])).toEqual(replaced);
        h.tasks.set(h.ids[0], original);
        h.close.mockResolvedValue(undefined);
        expect((await h.cancel(h.ids[0])).statusCode).toBe(200);
        expect(h.release).toHaveBeenCalledTimes(1);
      } finally {
        await h.dispose();
      }
    },
  );
  it.each([
    ['running', 200],
    ['absent', 200],
    ['expired', 404],
    ['foreign', 403],
    ['identity-changed', 409],
    ['terminal', 400],
    ['unsupported', 400],
  ] as const)(
    'releases pre-removal admission after %s so a ninth independent task is not blocked',
    async (outcome, status) => {
      const h = await settlementHarness(9);
      vi.mocked(h.port.cancelJob).mockResolvedValue(outcome);
      try {
        for (const id of h.ids)
          expect((await h.cancel(id)).statusCode).toBe(status);
        expect(h.port.cancelJob).toHaveBeenCalledTimes(9);
        expect(h.find).not.toHaveBeenCalled();
        expect(h.close).not.toHaveBeenCalled();
        expect(h.release).not.toHaveBeenCalled();
      } finally {
        await h.dispose();
      }
    },
  );
  it.each(['queue', 'mutate'] as const)(
    'retains known removal but releases unconfirmed admission on %s errors',
    async (failure) => {
      const h = await settlementHarness(9);
      if (failure === 'queue')
        vi.mocked(h.port.cancelJob).mockRejectedValue(
          new Error('synthetic queue error'),
        );
      else
        vi.mocked(h.port.store.mutate).mockRejectedValue(
          new Error('synthetic metadata error'),
        );
      try {
        for (const id of h.ids.slice(0, 8))
          expect((await h.cancel(id)).statusCode).toBe(500);
        expect((await h.cancel(h.ids[8])).statusCode).toBe(
          failure === 'queue' ? 500 : 429,
        );
        expect(h.port.cancelJob).toHaveBeenCalledTimes(
          failure === 'queue' ? 9 : 8,
        );
        expect(h.find).not.toHaveBeenCalled();
        expect(h.close).not.toHaveBeenCalled();
        expect(h.release).not.toHaveBeenCalled();
      } finally {
        await h.dispose();
      }
    },
  );
  it('rejects a cancelled metadata CAS with a different subtype and retains the original removal proof without closing another task', async () => {
    const h = await settlementHarness(9);
    vi.mocked(h.port.store.mutate).mockImplementation(async (id) => {
      const next = {
        ...h.tasks.get(id)!,
        status: 'cancelled' as const,
        taskSubType: 'competitor-variant-group-delete',
      };
      h.tasks.set(id, next);
      return next;
    });
    try {
      for (const id of h.ids.slice(0, 8))
        expect((await h.cancel(id)).statusCode).toBe(409);
      expect((await h.cancel(h.ids[8])).statusCode).toBe(429);
      expect(h.queued.has(h.ids[8])).toBe(true);
      expect(h.port.cancelJob).toHaveBeenCalledTimes(8);
      expect(h.find).not.toHaveBeenCalled();
      expect(h.close).not.toHaveBeenCalled();
      expect(h.release).not.toHaveBeenCalled();
    } finally {
      await h.dispose();
    }
  });
});
