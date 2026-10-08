import type { Env } from '@asin-monitor/config';
import {
  ASIN_EXPORT_MIN_TASK_TTL_SECONDS,
  PgAsinQueryRepository,
  TaskRegistryError,
} from '@asin-monitor/db';
import { HttpException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authorizeAdministration } from '../src/auth/administration-authorization';
import type { AuthPrincipal } from '../src/auth/auth.types';
import { AsinExportTaskService } from '../src/tasks/asin-export-task';
import type { TaskQueryRuntime } from '../src/tasks/task-query.runtime';
import { ExportEnqueueRejected } from '../src/tasks/task-query.runtime';

vi.mock('../src/auth/administration-authorization', () => ({
  authorizeAdministration: vi.fn(),
}));

const principal = { userId: 'owner', sessionId: 'session' } as AuthPrincipal;
const createdAt = '2026-09-27T00:00:00.000Z';
const createLimitedExport = vi.fn(
  async (
    input: { taskId: string },
    _perUserLimit: number,
    _globalLimit: number,
    onPrepared?: (identity: { createdAt: string }) => void,
  ) => {
    onPrepared?.({ createdAt });
    return { ...input, createdAt };
  },
);
const enqueue = vi.fn(async () => undefined);
const mutate = vi.fn(async () => ({ status: 'failed' }));
const recordRejected = vi.fn(async (_identity: unknown) => undefined);
const openExport = vi.fn(
  (_ensureOpen: () => void, onCreateWriteStarted?: () => void) => ({
    store: {
      createLimitedExport: (
        ...args: Parameters<typeof createLimitedExport>
      ) => {
        onCreateWriteStarted?.();
        return createLimitedExport(...args);
      },
      mutate,
    },
    enqueue,
    recordRejected,
  }),
);
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const pools = { primaryPool: {} };

function service(
  authority: Env['AUTH_DATA_AUTHORITY'] = 'postgresql',
  ttl = 604_800,
) {
  return new AsinExportTaskService(
    { AUTH_DATA_AUTHORITY: authority, TASK_META_TTL_SECONDS: ttl } as Env,
    pools as never,
    { openExport } as unknown as TaskQueryRuntime,
    logger as never,
  );
}

describe('ASIN export producer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(PgAsinQueryRepository.prototype, 'read').mockImplementation(
      async (operation) => operation({} as never),
    );
  });

  it('rejects unimplemented types and malformed ASIN filters without creating a task', async () => {
    const subject = service();
    await expect(
      subject.create(principal, { exportType: 'monitor-history' }),
    ).rejects.toMatchObject({ status: 501 });
    await expect(
      subject.create(principal, {
        exportType: 'asin',
        params: { country: 'US', unexpected: true },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(createLimitedExport).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('checks the live PostgreSQL grant before task creation and enqueues immutable identity', async () => {
    const subject = service();
    const result = await subject.create(principal, {
      exportType: 'asin',
      params: { country: 'US', variantStatus: 'BROKEN' },
    });
    expect(authorizeAdministration).toHaveBeenCalledWith(
      {},
      principal,
      'asin:read',
    );
    expect(result).toMatchObject({ exportType: 'asin', status: 'pending' });
    expect(createLimitedExport).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: result.taskId }),
      2,
      100,
      expect.any(Function),
    );
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: result.taskId,
        userId: principal.userId,
        createdAt,
        taskType: 'export',
        taskSubType: 'asin',
        params: { country: 'US', variantStatus: 'BROKEN' },
      }),
    );
  });

  it('stops when the live grant is revoked, authority is Legacy, or two exports are active', async () => {
    vi.mocked(authorizeAdministration).mockRejectedValueOnce(
      new HttpException('forbidden', 403),
    );
    await expect(
      service().create(principal, { exportType: 'asin' }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service('legacy-mysql').create(principal, { exportType: 'asin' }),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      service('postgresql', 60).create(principal, { exportType: 'asin' }),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      service('postgresql', ASIN_EXPORT_MIN_TASK_TTL_SECONDS - 1).create(
        principal,
        { exportType: 'asin' },
      ),
    ).rejects.toMatchObject({ status: 503 });
    createLimitedExport.mockRejectedValueOnce(
      new TaskRegistryError('TASK_EXPORT_LIMIT'),
    );
    await expect(
      service().create(principal, { exportType: 'asin' }),
    ).rejects.toMatchObject({ status: 429 });
    createLimitedExport.mockRejectedValueOnce(
      new TaskRegistryError('TASK_EXPORT_GLOBAL_LIMIT'),
    );
    await expect(
      service().create(principal, { exportType: 'asin' }),
    ).rejects.toMatchObject({ status: 429 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('marks definitive queue rejection failed and keeps unknown add outcomes queryable', async () => {
    enqueue.mockRejectedValueOnce(new ExportEnqueueRejected('unavailable'));
    await expect(
      service().create(principal, { exportType: 'asin' }),
    ).rejects.toMatchObject({ status: 503 });
    expect(mutate).toHaveBeenCalledWith(
      expect.any(String),
      { kind: 'failed', message: 'ASIN 导出未入队，请重试' },
      expect.objectContaining({ userId: principal.userId, createdAt }),
    );
    enqueue.mockRejectedValueOnce(new Error('Redis acknowledgement lost'));
    const uncertain = await service().create(principal, {
      exportType: 'asin',
    });
    expect(uncertain).toMatchObject({
      taskId: expect.any(String),
      exportType: 'asin',
      status: 'unknown',
    });
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('keeps a definitive rejection when Redis terminal cleanup fails and persists its immutable recovery identity', async () => {
    enqueue.mockRejectedValueOnce(new ExportEnqueueRejected('unavailable'));
    mutate.mockRejectedValueOnce(new Error('fixture Redis outage'));
    let response: unknown;
    try {
      await service().create(principal, { exportType: 'asin' });
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      expect((error as HttpException).getStatus()).toBe(503);
      response = (error as HttpException).getResponse();
    }
    expect(response).toMatchObject({
      data: {
        taskId: expect.any(String),
        exportType: 'asin',
        status: 'rejected',
      },
    });
    expect(recordRejected).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: (response as { data: { taskId: string } }).data.taskId,
        userId: principal.userId,
        taskType: 'export',
        taskSubType: 'asin',
        createdAt,
      }),
      expect.any(Number),
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { reason: 'export_enqueue_outcome_unknown' },
    );
  });

  it('never journals an uncertain add outcome as proof of rejection', async () => {
    enqueue.mockRejectedValueOnce(
      new Error('fixture add acknowledgement lost'),
    );
    expect(
      await service().create(principal, { exportType: 'asin' }),
    ).toMatchObject({ status: 'unknown' });
    expect(recordRejected).not.toHaveBeenCalled();
  });

  it('rejects readiness failure and durably rejects a create EVAL whose committed reply is lost before enqueue', async () => {
    openExport.mockImplementationOnce(() => ({
      store: {
        createLimitedExport: vi.fn(async () => {
          throw new Error('Redis not ready before EVAL');
        }),
        mutate,
      },
      enqueue,
      recordRejected,
    }));
    await expect(
      service().create(principal, { exportType: 'asin' }),
    ).rejects.toMatchObject({ status: 500 });
    expect(enqueue).not.toHaveBeenCalled();

    openExport.mockImplementationOnce((_ensureOpen, onWrite) => ({
      store: {
        createLimitedExport: vi.fn(
          async (_input, _limit, _global, onPrepared) => {
            onPrepared?.({ createdAt });
            onWrite?.();
            throw new Error('Redis EVAL acknowledgement lost');
          },
        ),
        mutate,
      },
      enqueue,
      recordRejected,
    }));
    await expect(
      service().create(principal, { exportType: 'asin' }),
    ).rejects.toMatchObject({ status: 503 });
    expect(recordRejected).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: principal.userId,
        createdAt,
        taskType: 'export',
        taskSubType: 'asin',
      }),
      expect.any(Number),
    );
    expect(mutate).toHaveBeenCalledWith(
      expect.any(String),
      { kind: 'failed', message: 'ASIN 导出未入队，请重试' },
      expect.objectContaining({ userId: principal.userId, createdAt }),
    );
    expect(enqueue).not.toHaveBeenCalled();
  });
});
