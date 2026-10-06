import {
  triggerCompetitorMonitorAsyncResultSchema,
  type CompetitorMonitorJob,
} from '@asin-monitor/contracts';
import type {
  SpApiConfigurationRepositoryPort,
  SpApiConfigurationUnit,
} from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompetitorMonitorTriggerModule } from '../src/competitor/competitor-monitor-trigger.module';
import { SP_API_CONFIG_REPOSITORY } from '../src/sp-api-config/sp-api-config.service';
import { TaskQueryRuntime } from '../src/tasks/task-query.runtime';
import { sessionApp } from './helpers/session-app';
import {
  taskAuthFixture,
  taskFixture,
  taskSessionId,
  taskUserId,
} from './helpers/task-query-fixtures';

describe('POST /competitor/monitor/trigger', () => {
  let app: Awaited<ReturnType<typeof sessionApp>>;
  let permissions: string[];
  const auth = taskAuthFixture();
  const unit = {
    lockOperator: vi.fn(async () => auth.user),
    lockSession: vi.fn(async () => auth.session),
    operatorPermissionCodes: vi.fn(async () => permissions),
    findConfiguration: vi.fn(
      async () => undefined as { configValue: string | null } | undefined,
    ),
  };
  const repository: SpApiConfigurationRepositoryPort = {
    readConfiguration: vi.fn(async () => []),
    transaction: vi.fn(async (action) =>
      action(unit as unknown as SpApiConfigurationUnit),
    ),
  };
  const consumer = vi.fn(async () => undefined);
  const create = vi.fn(async (input: { taskId: string }) =>
    taskFixture({
      ...input,
      taskId: input.taskId,
      userId: taskUserId,
      taskType: 'competitor-monitor',
      taskSubType: 'competitor',
      createdAt: new Date().toISOString(),
    }),
  );
  const mutate = vi.fn(async (taskId: string) =>
    taskFixture({
      taskId,
      userId: taskUserId,
      taskType: 'competitor-monitor',
      taskSubType: 'competitor',
      status: 'failed',
      createdAt: new Date().toISOString(),
    }),
  );
  const enqueue = vi.fn(async (_data: CompetitorMonitorJob) => undefined);
  const runtime = {
    openCompetitorMonitor: vi.fn(() => ({
      store: { create, mutate },
      assertConsumer: consumer,
      enqueue,
    })),
  };
  let headers: Record<string, string>;
  beforeEach(async () => {
    vi.clearAllMocks();
    unit.findConfiguration.mockResolvedValue(undefined);
    permissions = ['monitor:write'];
    auth.repository.getPermissionCodes.mockImplementation(
      async () => [...permissions] as never[],
    );
    app = await sessionApp(
      auth.repository,
      {},
      (builder) =>
        builder
          .overrideProvider(SP_API_CONFIG_REPOSITORY)
          .useValue(repository)
          .overrideProvider(TaskQueryRuntime)
          .useValue(runtime),
      [CompetitorMonitorTriggerModule],
    );
    headers = {
      authorization: `Bearer ${jwt.sign(
        { userId: taskUserId, sessionId: taskSessionId },
        app.env.JWT_SECRET,
        { expiresIn: '1h' },
      )}`,
    };
  });
  afterEach(async () => app.app.close());
  const post = (payload: unknown, customHeaders?: Record<string, string>) =>
    app.http.inject({
      method: 'POST',
      url: '/api/v1/competitor/monitor/trigger',
      payload: payload as object,
      headers: customHeaders ?? headers,
    });
  it('accepts a deduplicated arbitrary country selection and enqueues the owned job', async () => {
    const response = await post({ countries: [' us ', 'DE', 'US', 'fr'] });
    expect(response.statusCode).toBe(200);
    const body = triggerCompetitorMonitorAsyncResultSchema.parse(
      response.json(),
    );
    if (!body.data) throw new Error('Monitor result data missing');
    expect(body.data).toMatchObject({
      queued: true,
      countries: ['US', 'DE', 'FR'],
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: body.data.jobId,
        userId: taskUserId,
        taskType: 'competitor-monitor',
        taskSubType: 'competitor',
        countries: ['US', 'DE', 'FR'],
      }),
    );
    expect(unit.operatorPermissionCodes).toHaveBeenCalledWith(taskUserId);
  });
  it('rejects unauthenticated, unauthorized and invalid submissions without enqueueing', async () => {
    expect((await post({}, {})).statusCode).toBe(401);
    permissions = [];
    expect((await post({})).statusCode).toBe(403);
    permissions = ['monitor:write'];
    expect((await post({ countries: ['JP'] })).statusCode).toBe(400);
    expect((await post({ countries: ['US'], extra: true })).statusCode).toBe(
      400,
    );
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('does not claim a queue success without a live consumer', async () => {
    consumer.mockRejectedValueOnce(new Error('MONITOR_CONSUMER_NOT_READY'));
    const response = await post({ countries: ['UK'] });
    expect(response.statusCode).toBe(503);
    expect(create).not.toHaveBeenCalled();
  });
  it('rejects a full monitor queue before creating task metadata', async () => {
    consumer.mockRejectedValueOnce(new Error('MONITOR_QUEUE_FULL'));
    const response = await post({ countries: ['UK'] });
    expect(response.statusCode).toBe(429);
    expect(create).not.toHaveBeenCalled();
  });
  it('records a definite late queue refusal before returning its retryable status', async () => {
    enqueue.mockRejectedValueOnce(new Error('MONITOR_QUEUE_FULL'));
    const response = await post({ countries: ['UK'] });
    expect(response.statusCode).toBe(429);
    expect(create).toHaveBeenCalledOnce();
    expect(mutate).toHaveBeenCalledWith(
      expect.any(String),
      { kind: 'failed', message: '监控任务未入队，请重新提交' },
      expect.objectContaining({
        userId: taskUserId,
        taskType: 'competitor-monitor',
        taskSubType: 'competitor',
      }),
    );
  });
  it.each([
    ['MONITOR_ADMISSION_BUSY', 429],
    ['MONITOR_ADMISSION_LOST', 503],
  ] as const)(
    'records definite %s admission rejection before responding',
    async (reason, status) => {
      enqueue.mockRejectedValueOnce(new Error(reason));
      const response = await post({ countries: ['UK'] });
      expect(response.statusCode).toBe(status);
      expect(mutate).toHaveBeenCalledWith(
        expect.any(String),
        { kind: 'failed', message: '监控任务未入队，请重新提交' },
        expect.any(Object),
      );
    },
  );
  it('returns the task ID if admission is lost after BullMQ add', async () => {
    enqueue.mockRejectedValueOnce(new Error('MONITOR_ADMISSION_UNCONFIRMED'));
    const response = await post({ countries: ['UK'] });
    expect(response.statusCode).toBe(500);
    expect(response.json().data.status).toBe('unknown');
    expect(mutate).not.toHaveBeenCalled();
  });
  it('returns the lookup ID when a late refusal cannot be recorded', async () => {
    enqueue.mockRejectedValueOnce(new Error('MONITOR_CONSUMER_NOT_READY'));
    mutate.mockRejectedValueOnce(new Error('redis unavailable'));
    const response = await post({ countries: ['UK'] });
    expect(response.statusCode).toBe(500);
    expect(response.json().data.status).toBe('unknown');
    expect(response.json().data.taskId).toMatch(/^[a-f0-9-]{36}$/);
  });
  it('returns the lookup ID if enqueue acknowledgement is uncertain', async () => {
    enqueue.mockRejectedValueOnce(new Error('redis unavailable'));
    const response = await post({ countries: ['US'] });
    expect(response.statusCode).toBe(500);
    expect(response.json().data.taskId).toMatch(/^[a-f0-9-]{36}$/);
    expect(response.json().data.status).toBe('unknown');
  });
  it('defaults to six countries and keeps the async response distinct from Legacy', async () => {
    const response = await post({});
    expect(response.statusCode).toBe(200);
    expect(response.json().data.countries).toEqual([
      'US',
      'UK',
      'DE',
      'FR',
      'IT',
      'ES',
    ]);
    expect(response.json().data).not.toHaveProperty('totalChecked');
  });
  it('uses fresh DB disabled control before any consumer or task allocation', async () => {
    unit.findConfiguration.mockResolvedValueOnce({ configValue: ' false ' });
    const response = await post({ countries: ['US'] });
    expect(response.statusCode).toBe(503);
    expect(response.json().errorMessage).toBe('竞品监控已关闭');
    expect(consumer).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
  it('rechecks current monitor permission after a cached token passed guards', async () => {
    unit.operatorPermissionCodes.mockResolvedValueOnce([]);
    const response = await post({});
    expect(response.statusCode).toBe(403);
    expect(create).not.toHaveBeenCalled();
  });
  it('rechecks session state in the primary control transaction', async () => {
    unit.lockSession.mockResolvedValueOnce(undefined as never);
    const response = await post({});
    expect(response.statusCode).toBe(403);
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('does not log or return raw control query failures', async () => {
    unit.findConfiguration.mockRejectedValueOnce(
      new Error('fixture-private-control-secret'),
    );
    const response = await post({});
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('fixture-private-control-secret');
    expect(create).not.toHaveBeenCalled();
  });
});
