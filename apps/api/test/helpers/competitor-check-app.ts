import type { VariantCheckJobData } from '@asin-monitor/contracts';
import type {
  CompetitorAsin,
  CompetitorCheckRepositoryPort,
  CompetitorCheckUnit,
  CompetitorGroupCheckSnapshot,
  CompetitorSingleCheckSnapshot,
  CompetitorVariantGroup,
  TaskState,
  VariantCheckOperation,
} from '@asin-monitor/db';
import { transitionTask, VariantCheckError } from '@asin-monitor/db';
import type { CompetitorCheckContext } from '@asin-monitor/variant-check';
import jwt from 'jsonwebtoken';
import { vi } from 'vitest';
import { COMPETITOR_CHECK_REPOSITORY } from '../../src/competitor/competitor-check-storage.module';
import { CompetitorCheckModule } from '../../src/competitor/competitor-check.module';
import { ApplicationCompetitorCheckRuntime } from '../../src/competitor/competitor-check.runtime';
import { ApplicationSpApiRuntime } from '../../src/sp-api-runtime/sp-api-runtime';
import {
  TaskQueryRuntime,
  type CheckProducerPort,
  type TaskCancellationPort,
  type TaskQueryPort,
} from '../../src/tasks/task-query.runtime';
import { sessionApp } from './session-app';
import {
  taskAuthFixture,
  taskFixture,
  taskSessionId,
  taskUserId,
} from './task-query-fixtures';

const before = new Date('2026-01-01T00:00:00.000Z');
const checkedAt = new Date('2026-09-12T00:00:00.000Z');

function group(): CompetitorVariantGroup {
  return {
    id: 'cg1',
    name: 'Competitor fixture group',
    country: 'US',
    brand: 'Fixture',
    isBroken: false,
    variantStatus: 'NORMAL',
    feishuNotifyEnabled: true,
    createTime: before,
    updateTime: before,
    lastCheckTime: null,
  };
}

function asin(): CompetitorAsin {
  return {
    id: 'ca1',
    asin: 'B000000001',
    name: 'Competitor fixture ASIN',
    asinType: 'MAIN_LINK',
    country: 'US',
    brand: 'Fixture',
    variantGroupId: 'cg1',
    isBroken: false,
    variantStatus: 'NORMAL',
    createTime: before,
    updateTime: before,
    lastCheckTime: null,
    feishuNotifyEnabled: true,
  };
}

export async function competitorCheckApp(overrides: NodeJS.ProcessEnv = {}) {
  const auth = taskAuthFixture();
  const permissions = ['asin:read'];
  auth.repository.getPermissionCodes.mockImplementation(
    async () => [...permissions] as never[],
  );
  const tasks = new Map<string, TaskState>();
  const receipts = new Map<
    string,
    { operation: VariantCheckOperation; result: unknown }
  >();
  const enqueued = new Map<string, VariantCheckJobData>();
  const groupSnapshot: CompetitorGroupCheckSnapshot = {
    group: group(),
    asins: [asin()],
  };
  const singleSnapshot: CompetitorSingleCheckSnapshot = {
    group: groupSnapshot.group,
    asin: groupSnapshot.asins[0],
  };
  const unit: CompetitorCheckUnit = {
    lockOperator: vi.fn(async () => auth.user),
    lockSession: vi.fn(async () => auth.session),
    operatorPermissionCodes: vi.fn(async () => permissions),
    readReceipt: vi.fn<CompetitorCheckUnit['readReceipt']>(
      async (operation) => {
        const receipt = receipts.get(operation.operationKey);
        if (!receipt) return undefined;
        if (JSON.stringify(receipt.operation) !== JSON.stringify(operation))
          throw new VariantCheckError('operation-mismatch');
        return JSON.parse(JSON.stringify(receipt.result)) as unknown;
      },
    ),
    saveReceipt: vi.fn(async () => undefined),
    purgeExpiredReceipts: vi.fn(async () => 0),
    loadSingle: vi.fn(async (id: string) => {
      if (id !== singleSnapshot.asin.id)
        throw new VariantCheckError('asin-not-found');
      return structuredClone(singleSnapshot);
    }),
    loadGroup: vi.fn(async (id: string) => {
      if (id !== groupSnapshot.group.id)
        throw new VariantCheckError('group-not-found');
      return structuredClone(groupSnapshot);
    }),
    commitSingle: vi.fn(async () => ({
      ...singleSnapshot,
      result: {} as never,
    })),
    commitGroup: vi.fn(async () => ({
      ...groupSnapshot,
      observations: [],
    })),
  };
  const repository: CompetitorCheckRepositoryPort = {
    transaction: vi.fn(async (action) => action(unit)),
  };
  const singleResult = {
    isBroken: false,
    details: { asin: singleSnapshot.asin.asin, result: { fixture: true } },
  };
  const groupResult = {
    isBroken: false,
    brokenASINs: [],
    brokenByType: { SP_API_ERROR: 0, NOT_FOUND: 0, NO_VARIANTS: 0 },
    groupSnapshot: { id: groupSnapshot.group.id },
    details: { totalASINs: 1, brokenCount: 0, results: [] },
  };
  const pipeline = {
    checkSingle: vi.fn(async (_id: string, context: CompetitorCheckContext) => {
      await context.checkpoint();
      await context.authorize(unit);
      return singleResult;
    }),
    checkGroup: vi.fn(async (_id: string, context: CompetitorCheckContext) => {
      await context.checkpoint();
      await context.authorize(unit);
      return groupResult;
    }),
  };
  const producer = {
    store: {
      create: vi.fn<CheckProducerPort['store']['create']>(async (input) => {
        const now = new Date().toISOString();
        const task = taskFixture({
          ...input,
          taskId: input.taskId,
          taskSubType: input.taskSubType ?? null,
          createdAt: now,
          updatedAt: now,
        });
        tasks.set(task.taskId, task);
        return task;
      }),
    },
    enqueue: vi.fn(async (data: VariantCheckJobData) => {
      enqueued.set(data.taskId, data);
    }),
  };
  const port: TaskQueryPort = {
    store: {
      read: vi.fn(async (id) => tasks.get(id) ?? null),
      listUser: vi.fn(async (userId) =>
        [...tasks.values()].filter((task) => task.userId === userId),
      ),
      mutate: vi.fn(async (id, change) => {
        const task = tasks.get(id);
        if (!task) return null;
        const next = transitionTask(task, change, checkedAt);
        tasks.set(id, next);
        return next;
      }),
    },
    findJob: vi.fn(async () => null),
  };
  const cancellationPort: TaskCancellationPort = {
    store: port.store,
    cancelJob: vi.fn(async (task) =>
      enqueued.delete(task.taskId) ? 'removed' : 'absent',
    ),
  };
  const taskRuntime = {
    openCheck: vi.fn((_ensureOpen: () => void) => producer),
    open: vi.fn(() => port),
    openCancellation: vi.fn((_ensureOpen: () => void) => cancellationPort),
  };
  const app = await sessionApp(
    auth.repository,
    overrides,
    (builder) =>
      builder
        .overrideProvider(COMPETITOR_CHECK_REPOSITORY)
        .useValue(repository)
        .overrideProvider(ApplicationSpApiRuntime)
        .useValue({})
        .overrideProvider(ApplicationCompetitorCheckRuntime)
        .useValue({ pipeline })
        .overrideProvider(TaskQueryRuntime)
        .useValue(taskRuntime),
    [CompetitorCheckModule],
  );
  const headers = {
    authorization: `Bearer ${jwt.sign(
      { userId: taskUserId, sessionId: taskSessionId },
      app.env.JWT_SECRET,
      { expiresIn: '1h' },
    )}`,
  };
  return {
    ...app,
    auth,
    permissions,
    unit,
    repository,
    pipeline,
    producer,
    taskRuntime,
    tasks,
    receipts,
    enqueued,
    port,
    cancellationPort,
    headers,
    groupSnapshot,
    singleSnapshot,
  };
}
