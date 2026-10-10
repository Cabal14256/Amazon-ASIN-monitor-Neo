import { getPhysicalQueueName } from '@asin-monitor/config';
import {
  backupCreationFilename,
  backupFilenameCreatedAt,
  backupJobDataSchema,
  backupRestoreReceiptSchema,
  taskInfoResultSchema,
  variantCheckJobSchema,
  type BackupJobData,
} from '@asin-monitor/contracts';
import {
  backupCreationIdentity,
  backupUncommittedFailureReason,
  taskStateSchema,
} from '@asin-monitor/db';
import { isImportTaskData, type ImportTaskData } from '@asin-monitor/import';
import jwt from 'jsonwebtoken';
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskQueryModule } from '../src/tasks/task-query.module';
import { TaskQueryRuntime } from '../src/tasks/task-query.runtime';
import { backupCreationFixture } from './helpers/backup-creation-fixtures';
import { sessionApp } from './helpers/session-app';
import {
  taskAuthFixture,
  taskFixture,
  taskSessionId,
  taskUserId,
} from './helpers/task-query-fixtures';

interface RetainedJob {
  id: string;
  name: string;
  data: unknown;
  returnvalue: unknown;
  failedReason?: string;
  progress: number;
  getState: () => Promise<string>;
}
const transport = vi.hoisted(() => ({
  registryRaw: null as string | null,
  queueName: '',
  taskId: '',
  job: undefined as RetainedJob | undefined,
  firstRead: undefined as RetainedJob | undefined,
  reads: 0,
  redisGet: vi.fn(),
  redisEval: vi.fn(),
  queueGet: vi.fn(),
  disconnect: vi.fn(),
}));
// Only network commands are replaced. Runtime snapshot, registry parsing, task
// reconciliation, authentication, controller and public serializer stay real.
vi.mock('ioredis', () => ({
  Redis: class extends EventEmitter {
    status = 'ready';
    get = async (key: string) => {
      transport.redisGet(key);
      return transport.registryRaw;
    };
    eval = async (...args: unknown[]) => {
      transport.redisEval(...args);
      throw new Error('Unexpected registry write in a detail-only fixture');
    };
    disconnect = transport.disconnect;
  },
}));
vi.mock('bullmq', async (original) => ({
  ...(await original<typeof import('bullmq')>()),
  QueueGetters: class extends EventEmitter {
    readonly keys: Record<string, string>;
    constructor(private readonly name: string) {
      super();
      this.keys = { completed: this.toKey('completed') };
    }
    toKey = (id: string) => `fixture:${this.name}:${id}`;
    getJob = async (id: string) => {
      transport.queueGet(this.name, id);
      if (this.name !== transport.queueName || id !== transport.taskId)
        return undefined;
      transport.reads++;
      return transport.reads === 1 && transport.firstRead
        ? transport.firstRead
        : transport.job;
    };
    close = async () => undefined;
  },
}));

const identities = (['create', 'restore'] as const).flatMap((operation) =>
  (['primary', 'competitor'] as const).map((target) => ({ operation, target })),
);
const cancellation = { cancelled: true, message: '备份任务已取消' };
const createdAt = '2026-10-08T12:00:00.000Z';

function backupData({ operation, target }: (typeof identities)[number]) {
  const published = backupCreationFixture(taskUserId, createdAt);
  const common = { ...published.data, target };
  return backupJobDataSchema.parse(
    operation === 'create'
      ? common
      : {
          ...common,
          operation,
          taskSubType: operation,
          params: {
            filename: backupCreationFilename(common.taskId, createdAt, target),
          },
        },
  );
}
function successfulResult(data: BackupJobData) {
  if (data.operation === 'restore')
    return backupRestoreReceiptSchema.parse({
      operation: data.operation,
      format: 'custom',
      filename: data.params.filename,
      target: data.target,
      restoreMode: 'in-place',
      targetDatabaseChanged: true,
      verification: 'confirmed',
      message: '恢复完成',
    });
  const published = backupCreationFixture(data.userId, data.createdAt);
  const filename = backupCreationFilename(
    data.taskId,
    data.createdAt,
    data.target,
  );
  return {
    ...published.result,
    filename,
    target: data.target,
    createdAt: backupFilenameCreatedAt(filename)!,
    backupCreationCommit: {
      ...published.result.backupCreationCommit,
      creationIdentity: backupCreationIdentity(data),
    },
  };
}

describe('retained backup BullMQ snapshot to authenticated HTTP detail', () => {
  let app: Awaited<ReturnType<typeof sessionApp>>;
  let headers: { authorization: string };
  beforeEach(async () => {
    vi.clearAllMocks();
    transport.registryRaw = null;
    transport.job = undefined;
    transport.firstRead = undefined;
    transport.reads = 0;
    const auth = taskAuthFixture();
    app = await sessionApp(auth.repository, {}, undefined, [TaskQueryModule]);
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
  function retain(
    data: BackupJobData | ImportTaskData,
    result: unknown,
    name: string = 'operation' in data ? data.operation : 'asin-import',
  ) {
    transport.taskId = data.taskId;
    transport.queueName = getPhysicalQueueName(data.taskType);
    transport.job = {
      id: data.taskId,
      name,
      data,
      progress: 37,
      returnvalue: result,
      getState: vi.fn(async () => 'completed'),
    };
    return transport.job;
  }
  const get = () =>
    app.http.inject({
      method: 'GET',
      url: `/api/v1/tasks/${transport.taskId}`,
      headers,
    });
  function assertReadOnly() {
    expect(transport.redisGet).toHaveBeenCalledWith(
      `${app.env.BULL_PREFIX.trim()}:neo:task:meta:${transport.taskId}`,
    );
    expect(transport.redisEval).not.toHaveBeenCalled();
  }

  it.each(identities)(
    'binds clean failure proof to the immutable $operation/$target queue and keeps it private',
    async (identity) => {
      const data = backupData(identity);
      const job = retain(data, null);
      job.getState = vi.fn(async () => 'failed');
      job.failedReason = backupUncommittedFailureReason(
        data,
        'private-worker-message',
      );
      const direct = await app.app
        .get(TaskQueryRuntime)
        .open(() => undefined)
        .findJob(data.taskId, 'backup');
      expect(direct).toMatchObject({
        status: 'failed',
        backupUncommittedFailure: true,
      });
      const response = await get();
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject({
        status: 'failed',
        message: '任务执行失败',
      });
      expect(response.body).not.toContain('backupUncommittedFailure');
      expect(response.body).not.toContain('BACKUP_UNCOMMITTED');
      expect(response.body).not.toContain('private-worker-message');
      assertReadOnly();
    },
  );
  it.each(['missing', 'older-worker', 'different-request', 'malformed'])(
    'retains manual verification for an unproven failed queue (%s)',
    async (mode) => {
      const data = backupData({ operation: 'restore', target: 'primary' });
      const job = retain(data, null);
      job.getState = vi.fn(async () => 'failed');
      const reason = backupUncommittedFailureReason(
        data,
        'private-worker-message',
      );
      job.failedReason =
        mode === 'missing'
          ? undefined
          : mode === 'older-worker'
          ? '清理未确认 private-token'
          : mode === 'different-request'
          ? backupUncommittedFailureReason(
              {
                ...data,
                params: {
                  filename: 'backup_20260927-020000-abcdef01-primary.dump',
                },
              } as BackupJobData,
              'private-worker-message',
            )
          : reason.slice(0, -1);
      const direct = await app.app
        .get(TaskQueryRuntime)
        .open(() => undefined)
        .findJob(data.taskId, 'backup');
      expect(direct).toMatchObject({
        status: 'failed',
        backupUncommittedFailure: false,
      });
      const response = await get();
      expect(response.statusCode).toBe(200);
      expect(response.json().data.status).toBe('failed');
      expect(response.json().data.message).toContain('清理未确认');
      expect(response.body).not.toContain('private-');
      assertReadOnly();
    },
  );

  it.each(identities)(
    'reports missing-registry cancellation for the retained $operation/$target job in real HTTP',
    async (identity) => {
      const data = backupData(identity);
      const job = retain(data, cancellation);
      // BullMQ's first read may predate the completed returnvalue. Actual
      // Runtime must reload after getState before choosing public status.
      transport.firstRead = { ...job, returnvalue: null };
      const response = await get();
      const direct = await app.app
        .get(TaskQueryRuntime)
        .open(() => undefined)
        .findJob(data.taskId, 'backup');
      expect(response.statusCode).toBe(200);
      const result = taskInfoResultSchema.parse(response.json()).data;
      expect(result).toMatchObject({
        taskId: data.taskId,
        taskType: 'backup',
        taskSubType: identity.operation,
        status: 'cancelled',
        progress: 37,
        canCancel: false,
        downloadUrl: null,
        result: cancellation,
      });
      expect(direct).toMatchObject({ status: 'cancelled', backupData: data });
      expect(
        transport.queueGet.mock.calls.filter(
          ([name]) => name === transport.queueName,
        ),
      ).toHaveLength(4);
      expect(job.getState).toHaveBeenCalledTimes(2);
      expect(response.body).not.toContain('backupData');
      expect(response.body).not.toContain('params');
      assertReadOnly();
    },
  );
  it.each(identities)(
    'preserves actual successful $operation/$target receipt status without a registry',
    async (identity) => {
      const data = backupData(identity);
      const receipt = successfulResult(data);
      retain(data, receipt);
      const response = await get();
      expect(response.statusCode).toBe(200);
      expect(taskInfoResultSchema.parse(response.json()).data).toMatchObject({
        status: 'completed',
        canCancel: false,
        result: {
          operation: identity.operation,
          target: identity.target,
          filename: receipt.filename,
        },
      });
      expect(response.body).not.toContain('backupCreationCommit');
      assertReadOnly();
    },
  );
  it.each(identities)(
    'rejects a different owner of a retained $operation/$target cancellation',
    async (identity) => {
      const data = backupJobDataSchema.parse({
        ...backupData(identity),
        userId: 'different-backup-owner',
      });
      retain(data, cancellation);
      const response = await get();
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        success: false,
        errorCode: 403,
        errorMessage: '无权访问此任务',
      });
      expect(response.body).not.toContain('different-backup-owner');
      expect(response.body).not.toContain('备份任务已取消');
      assertReadOnly();
    },
  );
  it.each([
    {
      ...identities[0],
      result: { cancelled: false, message: cancellation.message },
    },
    {
      ...identities[1],
      result: { cancelled: 'true', message: cancellation.message },
    },
    {
      ...identities[2],
      result: { cancelled: 1, message: cancellation.message },
    },
    { ...identities[3], result: { message: cancellation.message } },
  ])(
    'does not interpret a non-true cancellation marker as $operation/$target cancellation',
    async ({ result, ...identity }) => {
      retain(backupData(identity), result);
      const response = await get();
      expect(response.statusCode).toBe(200);
      expect(taskInfoResultSchema.parse(response.json()).data?.status).toBe(
        'completed',
      );
      assertReadOnly();
    },
  );
  it.each(['data', 'job-id', 'job-name', 'restore-target'] as const)(
    'keeps immutable backup queue identity rejection for %s before public serialization',
    async (field) => {
      const data = backupData({ operation: 'restore', target: 'primary' });
      const job = retain(data, cancellation);
      if (field === 'data')
        job.data = { ...data, target: 'not-a-backup-target' };
      if (field === 'job-id') job.id = '20000000-0000-4000-8000-000000000171';
      if (field === 'job-name') job.name = 'create';
      if (field === 'restore-target')
        job.data = { ...data, target: 'competitor' };
      const response = await get();
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        success: false,
        errorCode: 500,
        errorMessage: '服务器内部错误',
      });
      expect(response.body).not.toContain('cancelled');
      expect(app.logger.error).toHaveBeenCalledWith(
        '任务查询失败',
        'TaskQueryService',
        { operation: 'detail', reason: 'task_query_failed' },
      );
      assertReadOnly();
    },
  );
  it.each(identities)(
    'preserves existing registry-terminal cancellation for $operation/$target',
    async (identity) => {
      const data = backupData(identity);
      const task = taskStateSchema.parse(
        taskFixture({
          ...data,
          status: 'cancelled',
          message: cancellation.message,
          cancelRequestedAt: createdAt,
          cancelledAt: createdAt,
          result: null,
        }),
      );
      transport.registryRaw = JSON.stringify(task);
      retain(data, cancellation);
      const response = await get();
      expect(response.statusCode).toBe(200);
      expect(taskInfoResultSchema.parse(response.json()).data).toMatchObject({
        status: 'cancelled',
        result: null,
        cancelledAt: createdAt,
      });
      assertReadOnly();
    },
  );
  it.each(['variant-check', 'batch-check'] as const)(
    'preserves existing completed %s cancellation classification',
    async (type) => {
      const base = backupData({ operation: 'create', target: 'primary' });
      const data = variantCheckJobSchema.parse({
        taskId: base.taskId,
        userId: base.userId,
        createdAt: base.createdAt,
        expiresAt: '2026-10-15T12:00:00.000Z',
        taskType: type,
        taskSubType: type === 'variant-check' ? 'asin-check' : 'variant-group',
        params:
          type === 'variant-check'
            ? { asinId: 'original-asin', forceRefresh: false }
            : { groupIds: ['original-group'], forceRefresh: false },
      });
      transport.taskId = data.taskId;
      transport.queueName = getPhysicalQueueName(type);
      transport.job = {
        id: data.taskId,
        name: type,
        data,
        progress: 37,
        returnvalue: { cancelled: true, message: '检查任务已取消' },
        getState: vi.fn(async () => 'completed'),
      };
      const response = await get();
      expect(response.statusCode).toBe(200);
      expect(taskInfoResultSchema.parse(response.json()).data).toMatchObject({
        status: 'cancelled',
        canCancel: false,
        taskType: type,
      });
      assertReadOnly();
    },
  );
  it('preserves ordinary successful import output through the same real snapshot and HTTP chain', async () => {
    const base = backupData({ operation: 'create', target: 'primary' });
    const data: ImportTaskData = {
      taskId: base.taskId,
      userId: base.userId,
      createdAt: base.createdAt,
      taskType: 'import',
      taskSubType: 'asin',
      title: 'ASIN导入',
      file: {
        taskId: base.taskId,
        extension: 'csv',
        originalFilename: 'fixture.csv',
        sha256: 'a'.repeat(64),
        bytes: 32,
      },
    };
    expect(isImportTaskData(data)).toBe(true);
    retain(data, { successCount: 2, failedCount: 0, message: '导入完成' });
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(taskInfoResultSchema.parse(response.json()).data).toMatchObject({
      taskType: 'import',
      taskSubType: 'asin',
      status: 'completed',
      result: { successCount: 2, failedCount: 0 },
    });
    assertReadOnly();
  });
});
