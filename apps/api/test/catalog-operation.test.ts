import {
  assertCatalogWriteExecution,
  CatalogOperationError,
  catalogTransactionExecution,
  PgCatalogOperationRepository,
  type CatalogOperationIdentity,
  type Db,
} from '@asin-monitor/db';
import { HttpException } from '@nestjs/common';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from 'vitest';
import type { AuthPrincipal } from '../src/auth/auth.types';
import { ApplicationCatalogOperations } from '../src/catalog/catalog-operation.service';
import type { ApplicationDatabasePools } from '../src/database/database.service';
import type { AppLogger } from '../src/logger/app-logger.service';
import {
  taskAuthFixture,
  taskFixture,
  taskSessionId,
  taskUserId,
} from './helpers/task-query-fixtures';

describe('durable catalog operation application boundary', () => {
  const identity: CatalogOperationIdentity = {
    ownerId: taskUserId,
    domain: 'asin',
    kind: 'write',
    generation: '7',
    operationId: '22400000-0000-4000-8000-000000000007',
  };
  const task = () =>
    taskFixture({
      taskId: '22400000-0000-4000-8000-000000000008',
      taskType: 'batch-delete',
      taskSubType: 'variant-group-delete',
      status: 'cancelled',
    });
  let auth: ReturnType<typeof taskAuthFixture>;
  let principal: AuthPrincipal;
  let permissions: string[];
  let service: ApplicationCatalogOperations;
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  let reserve: MockInstance<PgCatalogOperationRepository['reserve']>;
  let close: MockInstance<PgCatalogOperationRepository['close']>;
  let release: MockInstance<PgCatalogOperationRepository['release']>;
  let bind: MockInstance<PgCatalogOperationRepository['bindTask']>;
  let find: MockInstance<PgCatalogOperationRepository['findByTask']>;
  beforeEach(() => {
    vi.clearAllMocks();
    auth = taskAuthFixture();
    permissions = ['asin:write'];
    principal = {
      userId: taskUserId,
      sessionId: taskSessionId,
      user: { ...auth.user, status: 'ACTIVE', forcePasswordChange: false },
    };
    reserve = vi
      .spyOn(PgCatalogOperationRepository.prototype, 'reserve')
      .mockImplementation(async (input, authorize) => {
        await authorize({
          lockOperator: async () => auth.user,
          lockSession: async () => auth.session,
          operatorPermissionCodes: async () => permissions as never[],
        });
        return { ...identity, domain: input.domain, kind: input.kind };
      });
    close = vi
      .spyOn(PgCatalogOperationRepository.prototype, 'close')
      .mockResolvedValue(undefined);
    release = vi
      .spyOn(PgCatalogOperationRepository.prototype, 'release')
      .mockResolvedValue(true);
    bind = vi
      .spyOn(PgCatalogOperationRepository.prototype, 'bindTask')
      .mockResolvedValue(undefined);
    find = vi
      .spyOn(PgCatalogOperationRepository.prototype, 'findByTask')
      .mockResolvedValue({ ...identity, kind: 'batch-delete' });
    service = new ApplicationCatalogOperations(
      { primaryPool: {} } as unknown as ApplicationDatabasePools,
      logger as unknown as AppLogger,
    );
  });
  afterEach(() => vi.restoreAllMocks());
  const write = (
    action: Parameters<ApplicationCatalogOperations['execute']>[4],
  ) => service.execute(principal, 'asin', 'write', 'asin:write', action);

  it('checks current authorization in reserve before any business action', async () => {
    permissions = [];
    const action = vi.fn();
    await expect(write(action)).rejects.toBeInstanceOf(HttpException);
    expect(action).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(reserve).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: taskUserId, domain: 'asin' }),
      expect.any(Function),
    );
  });
  it('rejects a busy generation without invoking or releasing another operation', async () => {
    reserve.mockRejectedValueOnce(
      new CatalogOperationError('CATALOG_OPERATION_BUSY'),
    );
    const action = vi.fn();
    await expect(write(action)).rejects.toMatchObject({ status: 409 });
    expect(action).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
  it.each(['completed', 'failed'] as const)(
    'closes only its synchronous identity with %s proof',
    async (status) => {
      const action = async () => {
        if (status === 'failed') throw new Error('owned failure');
        return 17;
      };
      if (status === 'failed')
        await expect(write(action)).rejects.toThrow('owned failure');
      else expect(await write(action)).toBe(17);
      expect(close).toHaveBeenCalledWith(identity, { status, source: 'sync' });
      expect(release).toHaveBeenCalledWith(identity);
    },
  );
  it('attempts synchronous failure settlement when retention has no acknowledged binding', async () => {
    await expect(
      write(async (submission) => {
        submission.retain();
        throw new Error('ACK lost');
      }),
    ).rejects.toThrow('ACK lost');
    expect(close).toHaveBeenCalledExactlyOnceWith(identity, {
      status: 'failed',
      source: 'sync',
    });
    expect(release).toHaveBeenCalledExactlyOnceWith(identity);
  });
  it('leaves a physically pending sync operation reserved without changing its result', async () => {
    release.mockResolvedValueOnce(false);
    expect(await write(async () => 17)).toBe(17);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      'ApplicationCatalogOperations',
      expect.objectContaining({
        reason: 'catalog_operation_not_physically_settled',
      }),
    );
  });
  it('preserves the original result if the close acknowledgement is lost', async () => {
    close.mockRejectedValueOnce(new Error('close ACK lost'));
    expect(await write(async () => 17)).toBe(17);
    expect(release).not.toHaveBeenCalled();
  });
  it('binds the immutable five-field prepared identity before explicit producer rejection', async () => {
    const prepared = task();
    await service.execute(
      principal,
      'asin',
      'batch-delete',
      'asin:write',
      async (submission) => {
        submission.retain();
        await submission.bindTask(prepared);
        prepared.createdAt = '2099-01-01T00:00:00.000Z';
        expect(await submission.reject()).toBe(true);
      },
    );
    const expected = {
      taskId: task().taskId,
      userId: taskUserId,
      taskType: 'batch-delete',
      taskSubType: 'variant-group-delete',
      createdAt: task().createdAt,
    };
    const boundIdentity = { ...identity, kind: 'batch-delete' };
    expect(bind).toHaveBeenCalledWith(boundIdentity, expected);
    expect(close).toHaveBeenCalledExactlyOnceWith(boundIdentity, {
      status: 'rejected',
      source: 'producer',
      task: expected,
    });
  });
  it('retains a successful unbound action but settles a rejected foreign preparation synchronously', async () => {
    await write(async (submission) => {
      submission.retain();
      expect(await submission.reject()).toBe(false);
    });
    expect(close).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    await expect(
      write(async (submission) => {
        submission.retain();
        await submission.bindTask({ ...task(), userId: 'foreign' });
      }),
    ).rejects.toThrow('CATALOG_TASK_BINDING_INVALID');
    expect(bind).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledExactlyOnceWith(identity, {
      status: 'failed',
      source: 'sync',
    });
    expect(release).toHaveBeenCalledExactlyOnceWith(identity);
  });
  it('authorizes only the actual guarded transaction DB and removes it after settlement', async () => {
    const db = { execute: vi.fn() } as unknown as Pick<Db, 'execute'>;
    vi.spyOn(
      PgCatalogOperationRepository.prototype,
      'beginPin',
    ).mockResolvedValue({
      identity,
      pinId: '22400000-0000-4000-8000-000000000009',
    });
    vi.spyOn(
      PgCatalogOperationRepository.prototype,
      'assertPin',
    ).mockResolvedValue(undefined);
    vi.spyOn(
      PgCatalogOperationRepository.prototype,
      'finishPin',
    ).mockResolvedValue(undefined);
    await write(async () => {
      expect(() => assertCatalogWriteExecution(db, 'asin')).toThrow(
        'CATALOG_OPERATION_MISSING',
      );
      const execution = catalogTransactionExecution();
      await execution.begin();
      await execution.guard(db);
      expect(() => assertCatalogWriteExecution(db, 'asin')).not.toThrow();
      expect(() => assertCatalogWriteExecution(db, 'competitor')).toThrow(
        'CATALOG_OPERATION_IDENTITY',
      );
      await execution.settled('committed');
      expect(() => assertCatalogWriteExecution(db, 'asin')).toThrow(
        'CATALOG_OPERATION_MISSING',
      );
    });
  });
  it('closes only a cancelled task with its exact stored binding after confirmed queue removal', async () => {
    const lease = service.acquireCancellation({ ...task(), status: 'pending' });
    expect(lease).toBeDefined();
    lease!.markRemoved();
    await lease!.confirmRemoved(task(), performance.now() + 500);
    lease!.release();
    expect(find).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task().taskId,
        createdAt: task().createdAt,
      }),
    );
    expect(close).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'batch-delete' }),
      expect.objectContaining({ status: 'cancelled', source: 'cancel' }),
    );
    find.mockClear();
    close.mockClear();
    const invalid = service.acquireCancellation({
      ...task(),
      status: 'pending',
    });
    await expect(
      invalid!.confirmRemoved(
        { ...task(), status: 'processing' },
        performance.now() + 500,
      ),
    ).rejects.toMatchObject({ status: 409 });
    invalid!.release();
    expect(find).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
  it('keeps late cancellation settlement pending and coalesces retry until storage work settles', async () => {
    let finish!: () => void;
    close.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const lease = service.acquireCancellation({
      ...task(),
      status: 'pending',
    })!;
    lease.markRemoved();
    await lease.confirmRemoved(task(), performance.now() + 10);
    lease.release();
    expect(await service.retryRemovedTask(task(), performance.now() + 10)).toBe(
      true,
    );
    expect(find).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
  });
  it('reserves all eight admission leases before removal and frees an unconfirmed lease', () => {
    const leases = Array.from(
      { length: 8 },
      (_, index) =>
        service.acquireCancellation({
          ...task(),
          status: 'pending',
          taskId: `22400000-0000-4000-8000-${String(index + 100).padStart(
            12,
            '0',
          )}`,
        })!,
    );
    expect(() =>
      service.acquireCancellation({ ...task(), status: 'pending' }),
    ).toThrow(HttpException);
    expect(find).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    leases[0].release();
    const admitted = service.acquireCancellation({
      ...task(),
      status: 'pending',
    });
    expect(admitted).toBeDefined();
    admitted!.release();
    leases.forEach((lease) => lease.release());
  });
  it.each([
    'taskId',
    'userId',
    'taskType',
    'taskSubType',
    'createdAt',
  ] as const)(
    'freezes %s before queue removal and refuses a substituted cancelled record',
    async (field) => {
      const original = task();
      const prepared = { ...original, status: 'pending' as const };
      const lease = service.acquireCancellation(prepared)!;
      const next = { ...original };
      if (field === 'taskId')
        next.taskId = '22400000-0000-4000-8000-000000000019';
      else if (field === 'userId') next.userId = 'other-owner';
      else if (field === 'taskType') next.taskType = 'import';
      else if (field === 'taskSubType')
        next.taskSubType = 'competitor-variant-group-delete';
      else next.createdAt = '2099-01-01T00:00:00.000Z';
      await expect(
        lease.confirmRemoved(next, performance.now() + 500),
      ).rejects.toMatchObject({ status: 409 });
      expect(
        await service.retryRemovedTask(next, performance.now() + 500),
      ).toBe(false);
      expect(find).not.toHaveBeenCalled();
      expect(close).not.toHaveBeenCalled();
      // The admitted identity is an immutable copy, even if the original
      // metadata object is changed while the queue command is in flight.
      prepared.createdAt = '2099-01-01T00:00:00.000Z';
      lease.markRemoved();
      await lease.confirmRemoved(original, performance.now() + 500);
      expect(find).toHaveBeenCalledWith({
        taskId: original.taskId,
        userId: original.userId,
        taskType: original.taskType,
        taskSubType: original.taskSubType,
        createdAt: original.createdAt,
      });
      lease.release();
    },
  );
  it('bounds unconfirmed storage to three attempts and retains capacity until exact explicit retry succeeds', async () => {
    close.mockRejectedValue(new Error('synthetic close unavailable'));
    const cancelled = task();
    const lease = service.acquireCancellation({
      ...cancelled,
      status: 'pending',
    })!;
    lease.markRemoved();
    await lease.confirmRemoved(cancelled, performance.now() + 500);
    lease.release();
    expect(close).toHaveBeenCalledTimes(3);
    expect(find).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();
    const other = Array.from(
      { length: 7 },
      (_, index) =>
        service.acquireCancellation({
          ...task(),
          status: 'pending',
          taskId: `22400000-0000-4000-8000-${String(index + 100).padStart(
            12,
            '0',
          )}`,
        })!,
    );
    expect(() =>
      service.acquireCancellation({
        ...task(),
        status: 'pending',
        taskId: '22400000-0000-4000-8000-000000000200',
      }),
    ).toThrow(HttpException);
    expect(
      await service.retryRemovedTask(
        { ...cancelled, status: 'failed' },
        performance.now() + 500,
      ),
    ).toBe(false);
    expect(close).toHaveBeenCalledTimes(3);
    close.mockResolvedValue(undefined);
    expect(
      await service.retryRemovedTask(cancelled, performance.now() + 500),
    ).toBe(true);
    expect(find).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(4);
    expect(release).toHaveBeenCalledExactlyOnceWith({
      ...identity,
      kind: 'batch-delete',
    });
    expect(
      service.acquireCancellation({
        ...task(),
        status: 'pending',
        taskId: '22400000-0000-4000-8000-000000000200',
      }),
    ).toBeDefined();
    other.forEach((admitted) => admitted.release());
  });
  it('does not free a cancelled binding when physical pins still prevent release', async () => {
    release.mockResolvedValue(false);
    const lease = service.acquireCancellation({
      ...task(),
      status: 'pending',
    })!;
    lease.markRemoved();
    await lease.confirmRemoved(task(), performance.now() + 500);
    lease.release();
    expect(close).toHaveBeenCalledTimes(3);
    expect(release).toHaveBeenCalledTimes(3);
    expect(() =>
      service.acquireCancellation({ ...task(), status: 'pending' }),
    ).toThrow(HttpException);
    release.mockResolvedValue(true);
    expect(
      await service.retryRemovedTask(task(), performance.now() + 500),
    ).toBe(true);
    expect(release).toHaveBeenCalledTimes(4);
  });
  it('never turns an absent binding or a mismatched physical identity into release proof', async () => {
    find
      .mockRejectedValueOnce(
        new CatalogOperationError('CATALOG_OPERATION_MISSING'),
      )
      .mockResolvedValue({
        ...identity,
        ownerId: 'foreign',
        kind: 'batch-delete',
      });
    const lease = service.acquireCancellation({
      ...task(),
      status: 'pending',
    })!;
    lease.markRemoved();
    await lease.confirmRemoved(task(), performance.now() + 500);
    lease.release();
    expect(find).toHaveBeenCalledTimes(3);
    expect(close).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(() =>
      service.acquireCancellation({ ...task(), status: 'pending' }),
    ).toThrow(HttpException);
  });
  it('requires prior confirmed removal for a terminal retry and excludes non-catalog jobs', async () => {
    expect(
      await service.retryRemovedTask(task(), performance.now() + 500),
    ).toBe(false);
    const lease = service.acquireCancellation({
      ...task(),
      status: 'pending',
    })!;
    expect(
      await service.retryRemovedTask(task(), performance.now() + 500),
    ).toBe(false);
    lease.release();
    expect(
      service.acquireCancellation({
        ...task(),
        taskType: 'export',
        taskSubType: 'asin',
      }),
    ).toBeUndefined();
    expect(find).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});
