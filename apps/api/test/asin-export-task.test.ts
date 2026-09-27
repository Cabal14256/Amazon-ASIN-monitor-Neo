import type { Env } from '@asin-monitor/config';
import { PgAsinQueryRepository, TaskRegistryError } from '@asin-monitor/db';
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
const createLimitedExport = vi.fn(async (input: { taskId: string }) => ({
  ...input,
  createdAt,
}));
const enqueue = vi.fn(async () => undefined);
const mutate = vi.fn(async () => ({ status: 'failed' }));
const openExport = vi.fn(() => ({
  store: { createLimitedExport, mutate },
  enqueue,
}));
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const pools = { primaryPool: {} };

function service(authority: Env['AUTH_DATA_AUTHORITY'] = 'postgresql') {
  return new AsinExportTaskService(
    { AUTH_DATA_AUTHORITY: authority } as Env,
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
    createLimitedExport.mockRejectedValueOnce(
      new TaskRegistryError('TASK_EXPORT_LIMIT'),
    );
    await expect(
      service().create(principal, { exportType: 'asin' }),
    ).rejects.toMatchObject({ status: 429 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('marks definitive queue rejection failed and keeps unknown add outcomes queryable', async () => {
    enqueue.mockRejectedValueOnce(new ExportEnqueueRejected('queue-full'));
    await expect(
      service().create(principal, { exportType: 'asin' }),
    ).rejects.toMatchObject({ status: 429 });
    expect(mutate).toHaveBeenCalledWith(
      expect.any(String),
      { kind: 'failed', message: 'ASIN 导出未入队，请重试' },
      expect.objectContaining({ userId: principal.userId, createdAt }),
    );
    enqueue.mockRejectedValueOnce(new Error('Redis acknowledgement lost'));
    await expect(
      service().create(principal, { exportType: 'asin' }),
    ).rejects.toMatchObject({ status: 500 });
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});
