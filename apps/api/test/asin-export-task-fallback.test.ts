import { loadEnv } from '@asin-monitor/config';
import {
  asinExportJobDataSchema,
  taskInfoResultSchema,
} from '@asin-monitor/contracts';
import type { Job, QueueGetters } from 'bullmq';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLogger } from '../src/logger/app-logger.service';
import { TaskQueryModule } from '../src/tasks/task-query.module';
import {
  TASK_QUERY_QUEUES,
  TaskQueryRuntime,
  type TaskQueryPort,
} from '../src/tasks/task-query.runtime';
import { sessionApp } from './helpers/session-app';
import {
  taskAuthFixture,
  taskSessionId,
  taskUserId,
} from './helpers/task-query-fixtures';

describe('ASIN export cancellation after task metadata expires', () => {
  const taskId = '10000000-0000-4000-8000-000000000166';
  let app: Awaited<ReturnType<typeof sessionApp>>;
  let runtime: TaskQueryRuntime;
  let job: Job;
  let port: TaskQueryPort;
  let headers: { authorization: string };
  beforeEach(async () => {
    const env = loadEnv({
      DATABASE_URL: 'postgresql://localhost/task_fixture',
      COMPETITOR_DATABASE_URL: 'postgresql://localhost/task_competitor_fixture',
      REDIS_URL: 'redis://localhost:6379/15',
      AUTH_DATA_AUTHORITY: 'postgresql',
      JWT_SECRET: 'unused-fixture-key-for-export-cancellation-166',
    });
    runtime = new TaskQueryRuntime(env, {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as AppLogger);
    const io = runtime as unknown as {
      ready(): Promise<void>;
      queues: Map<string, QueueGetters>;
    };
    vi.spyOn(io, 'ready').mockResolvedValue();
    job = {
      id: taskId,
      name: 'asin',
      data: asinExportJobDataSchema.parse({
        taskId,
        taskType: 'export',
        taskSubType: 'asin',
        exportType: 'asin',
        userId: taskUserId,
        createdAt: '2026-09-27T00:00:00.000Z',
        params: {},
      }),
      returnvalue: { cancelled: true },
      progress: 0,
      getState: vi.fn(async () => 'completed'),
    } as unknown as Job;
    for (const type of TASK_QUERY_QUEUES) {
      io.queues.set(type, {
        keys: {},
        toKey: (id: string) => `fixture-${type}:${id}`,
        getJob: vi.fn(async (id: string) =>
          type === 'export' && id === taskId ? job : undefined,
        ),
        close: vi.fn(async () => undefined),
      } as unknown as QueueGetters);
    }
    const registry = {
      read: vi.fn(async () => null),
      listUser: vi.fn(async () => []),
      mutate: vi.fn(async () => null),
    } satisfies TaskQueryPort['store'];
    port = { ...runtime.open(() => undefined), store: registry };
    const auth = taskAuthFixture();
    app = await sessionApp(
      auth.repository,
      {},
      (builder) =>
        builder.overrideProvider(TaskQueryRuntime).useValue({
          open: (ensureOpen: () => void) => ({
            ...runtime.open(ensureOpen),
            store: registry,
          }),
        }),
      [TaskQueryModule],
    );
    headers = {
      authorization: `Bearer ${jwt.sign(
        { userId: taskUserId, sessionId: taskSessionId },
        app.env.JWT_SECRET,
        { expiresIn: '1h' },
      )}`,
    };
  });
  afterEach(async () => {
    await app?.app.close();
    await runtime?.onModuleDestroy();
    vi.restoreAllMocks();
  });
  const get = () =>
    app.http.inject({ method: 'GET', url: `/api/v1/tasks/${taskId}`, headers });

  it('maps an accepted completed cancellation marker through the real runtime snapshot', async () => {
    expect(await port.findJob(taskId, 'export')).toMatchObject({
      status: 'cancelled',
    });
  });
  it('returns a cancelled HTTP fallback without recreating metadata', async () => {
    const original = structuredClone(job.data);
    const response = await get();
    expect(response.statusCode).toBe(200);
    taskInfoResultSchema.parse(response.json());
    expect(response.json().data).toMatchObject({
      taskId,
      taskType: 'export',
      taskSubType: 'asin',
      status: 'cancelled',
      downloadUrl: null,
      filename: null,
      canCancel: false,
    });
    expect(port.store.mutate).not.toHaveBeenCalled();
    expect(job.data).toEqual(original);
  });
  it.each([false, 'true', null])(
    'keeps completion when cancelled is not boolean true (%s)',
    async (cancelled) => {
      job.returnvalue = { cancelled };
      expect((await get()).json().data.status).toBe('completed');
      expect(port.store.mutate).not.toHaveBeenCalled();
    },
  );
  it('keeps unrelated legacy export completion unchanged', async () => {
    job.name = 'fixture';
    expect((await get()).json().data.status).toBe('completed');
  });
  it.each(['taskId', 'taskType', 'params'] as const)(
    'rejects an incomplete or mismatched accepted export identity (%s)',
    async (field) => {
      job.data = {
        ...job.data,
        [field]:
          field === 'taskId'
            ? '10000000-0000-4000-8000-000000000999'
            : undefined,
      };
      expect((await get()).statusCode).toBe(500);
      expect(port.store.mutate).not.toHaveBeenCalled();
    },
  );
  it('denies a foreign cancelled export before returning its result', async () => {
    job.data.userId = 'foreign-owner';
    expect((await get()).statusCode).toBe(403);
    expect(port.store.mutate).not.toHaveBeenCalled();
  });
});
