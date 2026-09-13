import type {
  VariantCheckJobData,
  VariantGroupCheckData,
  VariantView,
} from '@asin-monitor/contracts';
import {
  transitionTask,
  VariantCheckError,
  type TaskState,
  type VariantCheckOperation,
  type VariantCheckRepositoryPort,
  type VariantCheckUnit,
} from '@asin-monitor/db';
import type { VariantCheckContext } from '@asin-monitor/variant-check';
import jwt from 'jsonwebtoken';
import { vi } from 'vitest';
import { ApplicationSpApiRuntime } from '../../src/sp-api-runtime/sp-api-runtime';
import {
  TaskQueryRuntime,
  type CheckProducerPort,
  type TaskQueryPort,
} from '../../src/tasks/task-query.runtime';
import { VARIANT_CHECK_REPOSITORY } from '../../src/variant-check/variant-check-storage.module';
import { VariantCheckModule } from '../../src/variant-check/variant-check.module';
import { ApplicationVariantCheckRuntime } from '../../src/variant-check/variant-check.runtime';
import { sessionApp } from './session-app';
import {
  taskAuthFixture,
  taskFixture,
  taskSessionId,
  taskUserId,
} from './task-query-fixtures';

export const checkView: VariantView = {
  asin: '',
  title: '',
  hasVariation: false,
  isBroken: false,
  parentAsin: null,
  brotherAsins: [],
  brand: null,
  raw: { details: { asin: 'B000000001', title: 'Full original title' } },
};
export const checkGroup: VariantGroupCheckData = {
  isBroken: false,
  brokenASINs: [],
  brokenByType: {},
  groupSnapshot: { id: 'g1', children: [{ id: 'a1' }] },
  details: { results: [{ variantView: checkView }] },
};
export async function variantCheckApp(overrides: NodeJS.ProcessEnv = {}) {
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
  const unit = {
    lockOperator: vi.fn(async () => auth.user),
    lockSession: vi.fn(async () => auth.session),
    operatorPermissionCodes: vi.fn(async () => permissions),
    readReceipt: vi.fn<VariantCheckUnit['readReceipt']>(async (operation) => {
      const receipt = receipts.get(operation.operationKey);
      if (!receipt) return undefined;
      if (JSON.stringify(receipt.operation) !== JSON.stringify(operation))
        throw new VariantCheckError('operation-mismatch');
      return JSON.parse(JSON.stringify(receipt.result)) as unknown;
    }),
  };
  const repository: VariantCheckRepositoryPort = {
    transaction: vi.fn(async (action) =>
      action(unit as unknown as VariantCheckUnit),
    ),
  };
  const pipeline = {
    checkSingle: vi.fn(
      async (
        _id: string,
        context: VariantCheckContext,
      ): Promise<VariantView> => {
        await context.checkpoint();
        await context.authorize(unit as unknown as VariantCheckUnit);
        return checkView;
      },
    ),
    checkGroup: vi.fn(
      async (
        _id: string,
        context: VariantCheckContext,
      ): Promise<VariantGroupCheckData> => {
        await context.checkpoint();
        await context.authorize(unit as unknown as VariantCheckUnit);
        return checkGroup;
      },
    ),
  };
  const executor = {
    checkGroups: vi.fn(
      async (
        ids: string[],
        context: VariantCheckContext,
        _concurrency: number,
      ) => {
        await context.checkpoint();
        await context.authorize(unit as unknown as VariantCheckUnit);
        return {
          total: ids.length,
          results: ids.map((groupId) => ({
            groupId,
            success: true,
            ...checkGroup,
          })),
        };
      },
    ),
  };
  const parents = {
    query: vi.fn(
      async (
        _asins: string[],
        _country: string,
        options: { onProgress?(): Promise<void> },
      ) => {
        await options.onProgress?.();
        return [
          {
            asin: 'B000000001',
            hasParentAsin: false,
            parentAsin: null,
            parentTitle: '',
            title: 'Complete title',
            brand: null,
            hasVariants: false,
            variantCount: 0,
            error: null,
          },
        ];
      },
    ),
  };
  const producer = {
    store: {
      create: vi.fn<CheckProducerPort['store']['create']>(async (input) => {
        const now = new Date().toISOString();
        const task = taskFixture({
          ...input,
          taskSubType: input.taskSubType ?? null,
          createdAt: now,
          updatedAt: now,
        });
        tasks.set(task.taskId, task);
        return task;
      }),
    },
    enqueue: vi.fn(async (_data: VariantCheckJobData) => undefined),
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
        const next = transitionTask(task, change, new Date());
        tasks.set(id, next);
        return next;
      }),
    },
    findJob: vi.fn(async () => null),
  };
  const taskRuntime = {
    openCheck: vi.fn((_ensureOpen: () => void) => producer),
    open: vi.fn(() => port),
  };
  const app = await sessionApp(
    auth.repository,
    overrides,
    (builder) =>
      builder
        .overrideProvider(VARIANT_CHECK_REPOSITORY)
        .useValue(repository)
        .overrideProvider(ApplicationSpApiRuntime)
        .useValue({})
        .overrideProvider(ApplicationVariantCheckRuntime)
        .useValue({ pipeline, parents, executor })
        .overrideProvider(TaskQueryRuntime)
        .useValue(taskRuntime),
    [VariantCheckModule],
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
    parents,
    executor,
    tasks,
    receipts,
    producer,
    port,
    taskRuntime,
    headers,
  };
}
