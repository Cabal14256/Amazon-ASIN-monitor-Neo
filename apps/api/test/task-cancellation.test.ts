import { taskInfoResultSchema } from '@asin-monitor/contracts';
import {
  TaskRegistryError,
  transitionTask,
  type TaskState,
} from '@asin-monitor/db';
import { ExportArtifactStore } from '@asin-monitor/export';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { finished } from 'node:stream/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLogger } from '../src/logger/app-logger.service';
import { ApplicationExportArtifacts } from '../src/tasks/export-storage.module';
import {
  CANCELLABLE_TASK_TYPES,
  type CancellationOutcome,
} from '../src/tasks/task-cancellation-script';
import { TaskQueryModule } from '../src/tasks/task-query.module';
import {
  TaskQueryRuntime,
  type TaskCancellationPort,
} from '../src/tasks/task-query.runtime';
import { WebSocketService } from '../src/websocket/websocket.service';
import { sessionApp } from './helpers/session-app';
import {
  taskAuthFixture,
  taskFixture,
  taskSessionId,
  taskUserId,
} from './helpers/task-query-fixtures';

describe('owned task cancellation HTTP', () => {
  let app: Awaited<ReturnType<typeof sessionApp>>,
    auth: ReturnType<typeof taskAuthFixture>;
  let task: TaskState | null,
    outcome: CancellationOutcome,
    port: TaskCancellationPort;
  let runtime: {
      openCancellation: ReturnType<typeof vi.fn>;
      discardExport: ReturnType<typeof vi.fn>;
    },
    ws: { sendTaskCancelled: ReturnType<typeof vi.fn> };
  let headers: { authorization: string };
  let artifacts: { discardFinal: ReturnType<typeof vi.fn> };
  let directory: string | undefined;
  let fileRuntime: TaskQueryRuntime;
  beforeEach(async () => {
    auth = taskAuthFixture();
    task = taskFixture();
    outcome = 'removed';
    port = {
      store: {
        read: vi.fn(async () => task),
        mutate: vi.fn(async (_id, change) =>
          task ? (task = transitionTask(task, change, new Date())) : null,
        ),
      },
      cancelJob: vi.fn(async () => outcome),
    };
    runtime = {
      openCancellation: vi.fn(() => port),
      discardExport: vi.fn((id, deadline, operation) =>
        fileRuntime.discardExport(id, deadline, operation),
      ),
    };
    artifacts = { discardFinal: vi.fn(async () => undefined) };
    ws = { sendTaskCancelled: vi.fn() };
    app = await sessionApp(
      auth.repository,
      {},
      (builder) =>
        builder
          .overrideProvider(TaskQueryRuntime)
          .useValue(runtime)
          .overrideProvider(WebSocketService)
          .useValue(ws)
          .overrideProvider(ApplicationExportArtifacts)
          .useValue(artifacts),
      [TaskQueryModule],
    );
    fileRuntime = new TaskQueryRuntime(
      app.env,
      app.logger as unknown as AppLogger,
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
    await fileRuntime.onModuleDestroy();
    await app.app.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;
    vi.restoreAllMocks();
  });
  const cancel = (requestHeaders = headers, id = 'task-95') =>
    app.http.inject({
      method: 'POST',
      url: `/api/v1/tasks/${id}/cancel`,
      headers: requestHeaders,
    });
  async function priorPublishedArtifact() {
    directory = await mkdtemp(join(tmpdir(), 'neo-cancel-export-'));
    const storage = new ExportArtifactStore(directory);
    task = taskFixture({ taskId: randomUUID(), status: 'processing' });
    artifacts.discardFinal.mockImplementation((id: string) =>
      storage.discardFinal(id),
    );
    const publish = async (id: string) => {
      const temporary = await storage.temporary(id);
      temporary.stream.end(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1]));
      await finished(temporary.stream);
      const artifact = await storage.publish(
        id,
        temporary.path,
        new AbortController().signal,
      );
      await storage.discard(temporary.path);
      return artifact;
    };
    const artifact = await publish(task.taskId);
    const neighbour = randomUUID();
    await publish(neighbour);
    // The previous attempt published its hard link but could not acknowledge
    // completion in the registry; a delayed retry still owns this file.
    vi.mocked(port.store.mutate).mockRejectedValueOnce(
      new Error('private-completion-ack-fixture'),
    );
    await expect(
      port.store.mutate(task.taskId, {
        kind: 'completed',
        result: { artifact },
      }),
    ).rejects.toThrow('private-completion-ack-fixture');
    expect(await storage.read(task.taskId)).not.toBeNull();
    return { storage, neighbour, id: task.taskId };
  }
  it.each(['removed', 'absent'] as const)(
    'deletes a prior published ASIN artifact after %s cancellation, preserving its neighbour',
    async (state) => {
      const { storage, neighbour, id } = await priorPublishedArtifact();
      outcome = state;
      const response = await cancel(headers, id);
      expect(response.statusCode).toBe(200);
      expect(response.json().data.status).toBe('cancelled');
      expect(await storage.read(id)).toBeNull();
      expect(await storage.read(neighbour)).not.toBeNull();
      expect(artifacts.discardFinal).toHaveBeenCalledExactlyOnceWith(id);
    },
  );
  it('leaves a running export artifact for the Worker to finalize cancellation', async () => {
    const { storage, id } = await priorPublishedArtifact();
    outcome = 'running';
    expect((await cancel(headers, id)).json().data.status).toBe('cancelling');
    expect(await storage.read(id)).not.toBeNull();
    expect(artifacts.discardFinal).not.toHaveBeenCalled();
  });
  it('does not apply ASIN artifact cleanup to another export family', async () => {
    const { storage, id } = await priorPublishedArtifact();
    task!.taskSubType = 'monitor-history';
    expect((await cancel(headers, id)).json().data.status).toBe('cancelled');
    expect(await storage.read(id)).not.toBeNull();
    expect(artifacts.discardFinal).not.toHaveBeenCalled();
  });
  it.each(['completed', 'failed', 'foreign', 'replaced', 'subtype'] as const)(
    'preserves the prior artifact when %s wins the cancellation boundary',
    async (state) => {
      const { storage, id } = await priorPublishedArtifact();
      if (state === 'foreign') task!.userId = 'another-user';
      else
        vi.mocked(port.store.mutate).mockResolvedValue({
          ...task!,
          status:
            state === 'completed' || state === 'failed' ? state : 'cancelled',
          ...(state === 'replaced'
            ? { createdAt: '2026-09-02T00:00:00.000Z' }
            : {}),
          ...(state === 'subtype' ? { taskSubType: 'monitor-history' } : {}),
        });
      expect((await cancel(headers, id)).statusCode).toBe(
        state === 'foreign'
          ? 403
          : state === 'replaced' || state === 'subtype'
          ? 409
          : 400,
      );
      expect(await storage.read(id)).not.toBeNull();
      expect(artifacts.discardFinal).not.toHaveBeenCalled();
    },
  );
  it('logs a fixed cleanup warning without reversing an acknowledged cancellation', async () => {
    const { storage, id } = await priorPublishedArtifact();
    artifacts.discardFinal.mockRejectedValue(
      new Error('private-delete-fixture'),
    );
    const response = await cancel(headers, id);
    expect(response.statusCode).toBe(200);
    expect(response.json().data.status).toBe('cancelled');
    expect(await storage.read(id)).not.toBeNull();
    expect(app.logger.warn).toHaveBeenCalledWith(
      '已取消导出文件清理未完成',
      'TaskCancellationService',
      { reason: 'cancelled_export_cleanup_failed' },
    );
    expect(JSON.stringify(app.logger.warn.mock.calls)).not.toContain(
      'private-delete-fixture',
    );
  });
  it('bounds cleanup by the existing deadline while permitting a safe late deletion', async () => {
    const { storage, neighbour, id } = await priorPublishedArtifact();
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const mutation = vi.mocked(port.store.mutate).getMockImplementation()!;
    vi.mocked(port.store.mutate).mockImplementation(async (...args) => {
      const next = await mutation(...args);
      clock = 2990;
      return next;
    });
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    artifacts.discardFinal.mockImplementation(async (value: string) => {
      await wait;
      await storage.discardFinal(value);
    });
    try {
      const before = Date.now();
      const response = await cancel(headers, id);
      expect(Date.now() - before).toBeLessThan(1000);
      expect(response.statusCode).toBe(200);
      expect(response.json().data.status).toBe('cancelled');
      expect(app.logger.warn).toHaveBeenCalledWith(
        '已取消导出文件清理未完成',
        'TaskCancellationService',
        { reason: 'cancelled_export_cleanup_failed' },
      );
      expect(await storage.read(id)).not.toBeNull();
    } finally {
      release();
    }
    await vi.waitFor(async () => expect(await storage.read(id)).toBeNull());
    expect(await storage.read(neighbour)).not.toBeNull();
  });
  it('requires login before opening the runtime', async () => {
    expect((await cancel({} as never)).statusCode).toBe(401);
    expect(runtime.openCancellation).not.toHaveBeenCalled();
  });
  it.each(['bearer', 'cookie'])(
    'rejects unexpected browser origins with %s authentication before task writes',
    async (method) => {
      const response = await app.http.inject({
        method: 'POST',
        url: '/api/v1/tasks/task-95/cancel',
        headers: {
          ...(method === 'bearer'
            ? headers
            : {
                cookie: `${
                  app.env.AUTH_COOKIE_NAME
                }=${headers.authorization.slice(7)}`,
              }),
          origin: 'https://untrusted.example',
        },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().errorMessage).toBe('不允许的请求来源');
      expect(runtime.openCancellation).not.toHaveBeenCalled();
    },
  );
  it('accepts an authenticated cookie from the configured browser origin', async () => {
    const response = await app.http.inject({
      method: 'POST',
      url: '/api/v1/tasks/task-95/cancel',
      headers: {
        cookie: `${app.env.AUTH_COOKIE_NAME}=${headers.authorization.slice(7)}`,
        origin: app.env.CORS_ORIGIN,
      },
    });
    expect(response.statusCode).toBe(200);
  });
  it.each(['account', 'session'])(
    'observes committed/current %s revocation',
    async (kind) => {
      if (kind === 'account') auth.user.status = 'SUSPENDED';
      else auth.session.status = 'REVOKED';
      expect((await cancel()).statusCode).toBe(403);
      expect(runtime.openCancellation).not.toHaveBeenCalled();
    },
  );
  it('gates the PostgreSQL authority before any task write', async () => {
    app.env.AUTH_DATA_AUTHORITY = 'legacy-mysql';
    expect((await cancel()).statusCode).toBe(503);
    expect(runtime.openCancellation).not.toHaveBeenCalled();
  });
  it.each(CANCELLABLE_TASK_TYPES)(
    'retains login-only %s cancellation and frozen response',
    async (type) => {
      task!.taskType = type;
      auth.user.forcePasswordChange = true;
      const response = await cancel();
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const result = taskInfoResultSchema.parse(response.json());
      expect(result.data).toMatchObject({
        status: 'cancelled',
        canCancel: false,
        message: '任务已取消（尚未开始执行）',
      });
      expect(port.store.mutate).toHaveBeenCalledWith(
        'task-95',
        { kind: 'cancelled', message: '任务已取消（尚未开始执行）' },
        {
          userId: taskUserId,
          taskType: type,
          createdAt: '2026-09-01T00:00:00.000Z',
        },
      );
      expect(auth.repository.getPermissionCodes).not.toHaveBeenCalled();
      expect(ws.sendTaskCancelled).not.toHaveBeenCalled();
    },
  );
  it.each(['foreign', 'ownerless'])(
    'rejects %s metadata before queue access',
    async (kind) => {
      task!.userId = kind === 'foreign' ? 'another-user' : '';
      expect((await cancel()).statusCode).toBe(403);
      expect(port.cancelJob).not.toHaveBeenCalled();
      expect(port.store.mutate).not.toHaveBeenCalled();
    },
  );
  it('does not fall back to a queue when metadata is missing', async () => {
    task = null;
    expect((await cancel()).statusCode).toBe(404);
    expect(port.cancelJob).not.toHaveBeenCalled();
  });
  it.each(['completed', 'failed', 'cancelled'] as const)(
    'preserves an existing %s task',
    async (status) => {
      task!.status = status;
      expect((await cancel()).statusCode).toBe(400);
      expect(port.cancelJob).not.toHaveBeenCalled();
      expect(port.store.mutate).not.toHaveBeenCalled();
    },
  );
  it.each(['competitor', 'unknown'])('refuses unsupported %s', async (type) => {
    task!.taskType = type;
    expect((await cancel()).statusCode).toBe(400);
    expect(port.cancelJob).not.toHaveBeenCalled();
  });
  it.each([
    ['expired', 404],
    ['foreign', 403],
    ['identity-changed', 409],
    ['terminal', 400],
    ['unsupported', 400],
  ] as const)(
    'does not mutate after atomic queue outcome %s',
    async (result, code) => {
      outcome = result;
      expect((await cancel()).statusCode).toBe(code);
      expect(port.store.mutate).not.toHaveBeenCalled();
      expect(ws.sendTaskCancelled).not.toHaveBeenCalled();
    },
  );
  it('cancels an absent job through durable metadata without a duplicate local notification', async () => {
    outcome = 'absent';
    expect((await cancel()).json().data).toMatchObject({
      status: 'cancelled',
      message: '任务已取消',
    });
    expect(ws.sendTaskCancelled).not.toHaveBeenCalled();
  });
  it('keeps running cancellation sticky and waits for the Worker to acknowledge', async () => {
    outcome = 'running';
    const first = (await cancel()).json().data;
    const second = (await cancel()).json().data;
    expect(first.status).toBe('cancelling');
    expect(second.cancelRequestedAt).toBe(first.cancelRequestedAt);
    expect(ws.sendTaskCancelled).not.toHaveBeenCalled();
  });
  it.each(['completed', 'failed'] as const)(
    'does not announce cancellation when %s wins the metadata CAS',
    async (status) => {
      vi.mocked(port.store.mutate).mockResolvedValue(taskFixture({ status }));
      expect((await cancel()).statusCode).toBe(400);
      expect(ws.sendTaskCancelled).not.toHaveBeenCalled();
    },
  );
  it('reports identity replacement during CAS without leaking the new record', async () => {
    vi.mocked(port.store.mutate).mockRejectedValue(
      new TaskRegistryError('TASK_IDENTITY_CHANGED'),
    );
    expect((await cancel()).statusCode).toBe(409);
    expect(ws.sendTaskCancelled).not.toHaveBeenCalled();
  });
  it('does not resurrect metadata which expires after removing the queue job', async () => {
    vi.mocked(port.store.mutate).mockResolvedValue(null);
    expect((await cancel()).statusCode).toBe(404);
    expect(ws.sendTaskCancelled).not.toHaveBeenCalled();
  });
  it('does not call the local WS helper after durable success', async () => {
    ws.sendTaskCancelled.mockImplementation(() => {
      throw new Error('private-token-fixture');
    });
    expect((await cancel()).statusCode).toBe(200);
    expect(ws.sendTaskCancelled).not.toHaveBeenCalled();
    expect(app.logger.warn).not.toHaveBeenCalled();
  });
  it.each(['read', 'queue', 'mutate'])(
    'returns fixed safe errors for %s failure',
    async (dependency) => {
      const fn =
        dependency === 'read'
          ? port.store.read
          : dependency === 'queue'
          ? port.cancelJob
          : port.store.mutate;
      vi.mocked(fn).mockRejectedValue(new Error('private-token-fixture'));
      const response = await cancel();
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('private-token-fixture');
      expect(JSON.stringify(app.logger.error.mock.calls)).not.toContain(
        'private-token-fixture',
      );
      expect(ws.sendTaskCancelled).not.toHaveBeenCalled();
    },
  );
  it('rejects control-character IDs without opening task dependencies', async () => {
    expect((await cancel(headers, 'bad%00id')).statusCode).toBe(400);
    expect(runtime.openCancellation).not.toHaveBeenCalled();
  });
  it('limits concurrent requests to eight and releases capacity after draining', async () => {
    const releases: (() => void)[] = [];
    vi.mocked(port.store.read).mockImplementation(async () => {
      await new Promise<void>((resolve) => releases.push(resolve));
      return taskFixture();
    });
    const pending = Array.from({ length: 8 }, () => Promise.resolve(cancel()));
    await vi.waitFor(() => expect(releases).toHaveLength(8));
    expect((await cancel()).statusCode).toBe(429);
    releases.forEach((release) => release());
    await Promise.all(pending);
    vi.mocked(port.store.read).mockResolvedValue(taskFixture());
    expect((await cancel()).statusCode).toBe(200);
  });
  it('starts no queue mutation after the logical deadline', async () => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.mocked(port.store.read).mockImplementation(async () => {
      clock = 3001;
      return task;
    });
    expect((await cancel()).statusCode).toBe(500);
    expect(port.cancelJob).not.toHaveBeenCalled();
    expect(port.store.mutate).not.toHaveBeenCalled();
  });
});
