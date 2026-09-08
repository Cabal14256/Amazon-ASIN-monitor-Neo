import {
  taskInfoResultSchema,
  taskListResultSchema,
} from '@asin-monitor/contracts';
import { transitionTask, type TaskState } from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QueueTaskSnapshot } from '../src/tasks/task-query-values';
import { TaskQueryModule } from '../src/tasks/task-query.module';
import {
  TaskQueryRuntime,
  type TaskQueryPort,
} from '../src/tasks/task-query.runtime';
import { sessionApp } from './helpers/session-app';
import {
  taskAuthFixture,
  taskFixture,
  taskSessionId,
  taskUserId,
} from './helpers/task-query-fixtures';

describe('own task query HTTP and bounded reconciliation', () => {
  let auth: ReturnType<typeof taskAuthFixture>,
    app: Awaited<ReturnType<typeof sessionApp>>;
  let task: TaskState | null,
    rows: TaskState[],
    queue: QueueTaskSnapshot | null;
  let port: TaskQueryPort, runtime: { open: ReturnType<typeof vi.fn> };
  let headers: { authorization: string };
  const paths = ['/tasks', '/tasks/task-95'];
  beforeEach(async () => {
    auth = taskAuthFixture();
    task = taskFixture();
    rows = [task];
    queue = null;
    port = {
      store: {
        read: vi.fn(async () => task),
        listUser: vi.fn(async () => rows),
        mutate: vi.fn(async (_id, change) =>
          task ? (task = transitionTask(task, change, new Date())) : null,
        ),
      },
      findJob: vi.fn(async () => queue),
    };
    runtime = { open: vi.fn(() => port) };
    app = await sessionApp(
      auth.repository,
      {},
      (builder) => builder.overrideProvider(TaskQueryRuntime).useValue(runtime),
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
    await app.app.close();
    vi.restoreAllMocks();
  });
  const get = (path = '/tasks/task-95', requestHeaders = headers) =>
    app.http.inject({
      method: 'GET',
      url: `/api/v1${path}`,
      headers: requestHeaders,
    });
  it.each(paths)('requires login: %s', async (path) => {
    expect((await get(path, {} as never)).statusCode).toBe(401);
    expect(runtime.open).not.toHaveBeenCalled();
  });
  it.each(paths)(
    'returns frozen envelope and no-store without extra permissions: %s',
    async (path) => {
      const response = await get(path);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      (path === paths[0] ? taskListResultSchema : taskInfoResultSchema).parse(
        response.json(),
      );
      expect(auth.repository.getPermissionCodes).not.toHaveBeenCalled();
    },
  );
  it.each(paths)('observes current account revocation: %s', async (path) => {
    auth.user.status = 'SUSPENDED';
    expect((await get(path)).statusCode).toBe(403);
    expect(runtime.open).not.toHaveBeenCalled();
  });
  it.each(paths)('observes current session revocation: %s', async (path) => {
    auth.session.status = 'REVOKED';
    expect((await get(path)).statusCode).toBe(403);
    expect(runtime.open).not.toHaveBeenCalled();
  });
  it('retains Legacy login-only access for an account pending a password change', async () => {
    auth.user.forcePasswordChange = true;
    expect((await get()).statusCode).toBe(200);
  });
  it('passes only current user and normalized filters to the index', async () => {
    expect((await get('/tasks?limit=200&status=active')).statusCode).toBe(200);
    expect(port.store.listUser).toHaveBeenCalledWith(taskUserId, {
      status: 'active',
      limit: 200,
    });
  });
  it.each([
    '/tasks?limit=201',
    '/tasks?userId=foreign',
    '/tasks?status=a&status=b',
    '/tasks/a%00b',
  ])('rejects invalid input %s', async (path) => {
    expect((await get(path)).statusCode).toBe(400);
    expect(port.findJob).not.toHaveBeenCalled();
    expect(port.store.read).not.toHaveBeenCalled();
    expect(port.store.listUser).not.toHaveBeenCalled();
  });
  it('lets Fastify reject an overlong route parameter before dependencies', async () => {
    expect((await get(`/tasks/${'x'.repeat(201)}`)).statusCode).toBe(414);
    expect(runtime.open).not.toHaveBeenCalled();
  });
  it('denies another owner before any queue lookup or registry mutation', async () => {
    task!.userId = 'other';
    queue = { ...task!, status: 'completed' };
    expect((await get()).statusCode).toBe(403);
    expect(port.findJob).not.toHaveBeenCalled();
    expect(port.store.mutate).not.toHaveBeenCalled();
  });
  it('fails closed if an index contains another owner', async () => {
    rows.push(taskFixture({ taskId: 'foreign', userId: 'other' }));
    expect((await get('/tasks')).statusCode).toBe(403);
    expect(port.findJob).not.toHaveBeenCalled();
  });
  it.each(['completed', 'failed', 'cancelled'] as const)(
    'does not consult queue or change terminal %s',
    async (status) => {
      task!.status = status;
      const before = structuredClone(task);
      expect((await get()).json().data.status).toBe(status);
      expect(task).toEqual(before);
      expect(port.findJob).not.toHaveBeenCalled();
    },
  );
  it('reconciles completed queue result with immutable task identity', async () => {
    const before = structuredClone(task!);
    queue = {
      ...task!,
      status: 'completed',
      message: '共3条',
      result: { total: 3 },
    };
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      status: 'completed',
      progress: 100,
      result: { total: 3 },
    });
    expect(port.store.mutate).toHaveBeenCalledWith(
      'task-95',
      { kind: 'completed', result: { total: 3 }, message: '共3条' },
      {
        userId: before.userId,
        taskType: before.taskType,
        createdAt: before.createdAt,
      },
    );
  });
  it('does not copy an untrusted queue failedReason into public task error', async () => {
    queue = { ...task!, status: 'failed', error: 'private-driver-payload' };
    const response = await get();
    expect(response.json().data.error).toBe('任务执行失败');
    expect(response.body).not.toContain('private');
  });
  it.each(['pending', 'processing', 'cancelling'])(
    'does not replace nonterminal %s metadata with queue progress',
    async (status) => {
      task!.status = status as TaskState['status'];
      queue = { ...task!, status: 'processing', progress: 90 };
      expect((await get()).json().data.progress).toBe(0);
      expect(port.store.mutate).not.toHaveBeenCalled();
    },
  );
  it('does not overwrite a cancellation that wins the CAS race', async () => {
    queue = { ...task!, status: 'completed', result: { total: 5 } };
    vi.mocked(port.store.mutate).mockImplementationOnce(async () => ({
      ...task!,
      status: 'cancelled',
      result: null,
    }));
    expect((await get()).json().data).toMatchObject({
      status: 'cancelled',
      result: null,
    });
  });
  it.each([null, 'foreign'])(
    'denies ownerless or foreign queue fallback (%s)',
    async (userId) => {
      queue = { ...task!, userId };
      task = null;
      expect((await get()).statusCode).toBe(403);
      expect(port.store.mutate).not.toHaveBeenCalled();
    },
  );
  it('returns own queue fallback without resurrecting missing metadata', async () => {
    queue = { ...task!, status: 'completed', result: { total: 2 } };
    task = null;
    expect((await get()).json().data).toMatchObject({
      status: 'completed',
      result: { total: 2 },
    });
    expect(port.store.mutate).not.toHaveBeenCalled();
  });
  it('returns 404 only when both sources are absent', async () => {
    task = null;
    expect((await get()).statusCode).toBe(404);
  });
  it('denies queue owner mismatch before touching own registry', async () => {
    queue = { ...task!, status: 'completed', userId: 'other' };
    expect((await get()).statusCode).toBe(403);
    expect(port.store.mutate).not.toHaveBeenCalled();
  });
  it('does not turn expiry during reconciliation into a successful stale detail', async () => {
    queue = { ...task!, status: 'completed' };
    vi.mocked(port.store.mutate).mockResolvedValueOnce(null);
    expect((await get()).statusCode).toBe(404);
  });
  it('returns fixed 500 for detail dependency failure without logging payload', async () => {
    vi.mocked(port.findJob).mockRejectedValueOnce(
      new Error('private-token-driver-error'),
    );
    const response = await get();
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('private');
    expect(JSON.stringify(app.logger.error.mock.calls)).not.toContain(
      'private',
    );
  });
  it('keeps stored list data and emits one fixed warning when reconciliation fails', async () => {
    vi.mocked(port.findJob).mockRejectedValue(
      new Error('private-token-driver-error'),
    );
    const response = await get('/tasks');
    expect(response.statusCode).toBe(200);
    expect(response.json().data[0].status).toBe('pending');
    expect(app.logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(app.logger.warn.mock.calls)).not.toContain('private');
  });
  it('does not use empty successful lists as a Redis outage fallback', async () => {
    vi.mocked(port.store.listUser).mockRejectedValue(
      new Error('private-redis-error'),
    );
    expect((await get('/tasks')).statusCode).toBe(500);
    expect(port.findJob).not.toHaveBeenCalled();
  });
  it('checks at most four list jobs concurrently and stops launching after failure', async () => {
    rows = Array.from({ length: 20 }, (_, index) =>
      taskFixture({ taskId: `task-${index}` }),
    );
    const releases: Array<() => void> = [];
    vi.mocked(port.findJob).mockImplementation(
      () =>
        new Promise((_resolve, reject) =>
          releases.push(() => reject(new Error('fixture-fail'))),
        ),
    );
    const pending = get('/tasks').then((value) => value);
    try {
      await vi.waitFor(() => expect(releases.length).toBe(4));
      releases.splice(0).forEach((release) => release());
      expect((await pending).statusCode).toBe(200);
      expect(port.findJob).toHaveBeenCalledTimes(4);
    } finally {
      releases.splice(0).forEach((release) => release());
      await pending;
    }
  });
  it('rejects a ninth in-flight query and frees capacity after completion', async () => {
    const releases: Array<() => void> = [];
    vi.mocked(port.store.read).mockImplementation(
      () => new Promise((resolve) => releases.push(() => resolve(task))),
    );
    const pending = Array.from({ length: 8 }, () =>
      get().then((response) => response),
    );
    try {
      await vi.waitFor(() => expect(releases).toHaveLength(8));
      expect((await get()).statusCode).toBe(429);
      releases.splice(0).forEach((release) => release());
      expect(
        (await Promise.all(pending)).map((response) => response.statusCode),
      ).toEqual(Array(8).fill(200));
      vi.mocked(port.store.read).mockResolvedValue(task);
      expect((await get()).statusCode).toBe(200);
    } finally {
      releases.splice(0).forEach((release) => release());
      await Promise.all(pending);
    }
  });
  it('stops starting further list reconciliation after the request deadline', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    rows = Array.from({ length: 10 }, (_, index) =>
      taskFixture({ taskId: `deadline-${index}` }),
    );
    vi.mocked(port.findJob).mockImplementation(async () => {
      now = 3001;
      return null;
    });
    const response = await get('/tasks');
    expect(response.statusCode).toBe(200);
    expect(port.findJob).toHaveBeenCalledTimes(1);
    expect(response.json().data).toHaveLength(10);
  });
});
