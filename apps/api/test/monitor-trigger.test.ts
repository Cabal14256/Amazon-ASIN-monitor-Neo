import {
  triggerMonitorResultSchema,
  type PrimaryMonitorJob,
} from '@asin-monitor/contracts';
import type {
  VariantCheckRepositoryPort,
  VariantCheckUnit,
} from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MonitorTriggerModule } from '../src/monitor/monitor-trigger.module';
import { TaskQueryRuntime } from '../src/tasks/task-query.runtime';
import { VARIANT_CHECK_REPOSITORY } from '../src/variant-check/variant-check-storage.module';
import { sessionApp } from './helpers/session-app';
import {
  taskAuthFixture,
  taskFixture,
  taskSessionId,
  taskUserId,
} from './helpers/task-query-fixtures';

describe('POST /monitor/trigger', () => {
  let app: Awaited<ReturnType<typeof sessionApp>>;
  let permissions: string[];
  const auth = taskAuthFixture();
  const unit = {
    lockOperator: vi.fn(async () => auth.user),
    lockSession: vi.fn(async () => auth.session),
    operatorPermissionCodes: vi.fn(async () => permissions),
  };
  const repository: VariantCheckRepositoryPort = {
    transaction: vi.fn(async (action) =>
      action(unit as unknown as VariantCheckUnit),
    ),
  };
  const consumer = vi.fn(async () => undefined);
  const create = vi.fn(async (input: { taskId: string }) =>
    taskFixture({
      ...input,
      taskId: input.taskId,
      userId: taskUserId,
      taskType: 'monitor',
      taskSubType: 'primary',
      createdAt: new Date().toISOString(),
    }),
  );
  const enqueue = vi.fn(async (_data: PrimaryMonitorJob) => undefined);
  const runtime = {
    openMonitor: vi.fn(() => ({
      store: { create },
      assertConsumer: consumer,
      enqueue,
    })),
  };
  let headers: Record<string, string>;
  beforeEach(async () => {
    vi.clearAllMocks();
    permissions = ['monitor:write'];
    auth.repository.getPermissionCodes.mockImplementation(
      async () => [...permissions] as never[],
    );
    app = await sessionApp(
      auth.repository,
      {},
      (builder) =>
        builder
          .overrideProvider(VARIANT_CHECK_REPOSITORY)
          .useValue(repository)
          .overrideProvider(TaskQueryRuntime)
          .useValue(runtime),
      [MonitorTriggerModule],
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
      url: '/api/v1/monitor/trigger',
      payload: payload as object,
      headers: customHeaders ?? headers,
    });
  it('accepts a deduplicated arbitrary country selection and enqueues the owned job', async () => {
    const response = await post({ countries: [' us ', 'DE', 'US', 'fr'] });
    expect(response.statusCode).toBe(200);
    const body = triggerMonitorResultSchema.parse(response.json());
    if (!body.data) throw new Error('Monitor result data missing');
    expect(body.data).toMatchObject({
      queued: true,
      countries: ['US', 'DE', 'FR'],
    });
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: body.data.jobId,
        userId: taskUserId,
        taskType: 'monitor',
        taskSubType: 'primary',
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
  it('returns the lookup ID if enqueue acknowledgement is uncertain', async () => {
    enqueue.mockRejectedValueOnce(new Error('redis unavailable'));
    const response = await post({ countries: ['US'] });
    expect(response.statusCode).toBe(500);
    expect(response.json().data.taskId).toMatch(/^[a-f0-9-]{36}$/);
    expect(response.json().data.status).toBe('unknown');
  });
});
