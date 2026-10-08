import {
  competitorMonitorJobSchema,
  primaryMonitorJobSchema,
} from '@asin-monitor/contracts';
import {
  asinBatchDeleteTaskDataSchema,
  CatalogOperationError,
  competitorBatchDeleteTaskDataSchema,
  parseCatalogTaskBinding,
  parseCompetitorMonitorCompletion,
  taskMatchesCatalogOperation,
  withCatalogOperationExecution,
  type CatalogOperationIdentity,
  type CatalogOperationPin,
  type CatalogOperationSnapshot,
  type CatalogPhysicalOutcome,
  type CatalogTaskBinding,
  type PgCatalogOperationRepository,
  type RedisTaskRepository,
  type TaskState,
} from '@asin-monitor/db';
import {
  isAsinImportTaskData,
  isCompetitorImportTaskData,
} from '@asin-monitor/import';
import {
  parseVariantCheckJob,
  variantCheckJobOperation,
  variantCheckResultOperation,
} from '@asin-monitor/variant-check';
import { UnrecoverableError, type Job, type Processor } from 'bullmq';
import { logger } from './logger';

function sameTask(
  value: CatalogTaskBinding | TaskState | null,
  task: CatalogTaskBinding,
) {
  return (
    !!value &&
    value.taskId === task.taskId &&
    value.userId === task.userId &&
    value.taskType === task.taskType &&
    value.taskSubType === task.taskSubType &&
    value.createdAt === task.createdAt
  );
}
function sameIdentity(
  value: CatalogOperationIdentity | null,
  identity: CatalogOperationIdentity,
) {
  return (
    !!value &&
    value.ownerId === identity.ownerId &&
    value.domain === identity.domain &&
    value.operationId === identity.operationId &&
    value.generation === identity.generation &&
    value.kind === identity.kind
  );
}
function requireSnapshot(
  value: CatalogOperationSnapshot | null,
  identity: CatalogOperationIdentity,
  task: CatalogTaskBinding,
): CatalogOperationSnapshot {
  if (
    !sameIdentity(value, identity) ||
    !taskMatchesCatalogOperation(identity, task) ||
    !sameTask(value?.task ?? null, task) ||
    value?.expectedTaskId !== task.taskId
  )
    throw new CatalogOperationError('CATALOG_OPERATION_IDENTITY');
  return value!;
}
function binding(job: Job, taskType: CatalogTaskBinding['taskType']) {
  const raw = job.data as Record<string, unknown> | null;
  const task = parseCatalogTaskBinding({
    taskId: raw?.taskId,
    userId: raw?.userId,
    taskType: raw?.taskType,
    taskSubType: raw?.taskSubType,
    createdAt: raw?.createdAt,
  });
  const domain = task.taskSubType.startsWith('competitor')
    ? 'competitor'
    : 'asin';
  const kind =
    taskType === 'monitor' || taskType === 'competitor-monitor'
      ? 'monitor'
      : taskType === 'variant-check' || taskType === 'batch-check'
      ? 'check'
      : taskType;
  const name =
    kind === 'import' || kind === 'batch-delete'
      ? `${domain}-${kind}`
      : kind === 'monitor'
      ? `${domain === 'asin' ? 'primary' : 'competitor'}-monitor`
      : taskType;
  if (
    task.taskType !== taskType ||
    job.id !== task.taskId ||
    job.name !== name ||
    !taskMatchesCatalogOperation(
      {
        ownerId: task.userId,
        domain,
        kind,
        operationId: '00000000-0000-4000-8000-000000000000',
        generation: '1',
      },
      task,
    )
  )
    throw new CatalogOperationError('CATALOG_OPERATION_IDENTITY');
  return task;
}
function rejected(error: unknown): Error {
  if (error instanceof UnrecoverableError) return error;
  return error instanceof CatalogOperationError &&
    [
      'CATALOG_OPERATION_MISSING',
      'CATALOG_OPERATION_IDENTITY',
      'CATALOG_OPERATION_INVALID',
      'CATALOG_OPERATION_CLOSED',
    ].includes(error.code)
    ? new UnrecoverableError('目录操作身份无效，任务已停止')
    : new Error('目录操作状态暂不可用，请核实任务和目录后恢复');
}
function completedResult(job: Job, state: TaskState) {
  // This path only reads an existing, exact task incarnation. It never invokes
  // a processor or opens a catalog execution, and preserves the consumers'
  // payload/result validation before returning their terminal metadata.
  try {
    switch (state.taskType) {
      case 'batch-delete':
        (state.taskSubType === 'competitor-variant-group-delete'
          ? competitorBatchDeleteTaskDataSchema
          : asinBatchDeleteTaskDataSchema
        ).parse(job.data);
        break;
      case 'import': {
        const raw = job.data as { domain?: unknown };
        if (
          state.taskSubType === 'competitor-asin'
            ? !isCompetitorImportTaskData(raw)
            : raw.domain !== undefined || !isAsinImportTaskData(raw)
        )
          throw new Error();
        break;
      }
      case 'variant-check':
      case 'batch-check': {
        const data = parseVariantCheckJob(job.data);
        if (
          JSON.stringify(variantCheckJobOperation(data)) !==
          JSON.stringify(variantCheckResultOperation(state, state.result))
        )
          throw new Error();
        break;
      }
      case 'monitor':
        primaryMonitorJobSchema.parse(job.data);
        break;
      case 'competitor-monitor':
        return parseCompetitorMonitorCompletion(
          competitorMonitorJobSchema.parse(job.data),
          state.result,
        );
      default:
        throw new Error();
    }
    return state.result;
  } catch {
    throw new CatalogOperationError('CATALOG_OPERATION_IDENTITY');
  }
}
function cancelledResult(taskType: CatalogTaskBinding['taskType']) {
  if (taskType === 'monitor' || taskType === 'competitor-monitor')
    return { cancelled: true };
  return {
    cancelled: true,
    message:
      taskType === 'import'
        ? '导入任务已取消，已提交的数据保留'
        : taskType === 'batch-delete'
        ? '批量删除任务已取消'
        : '检查任务已取消，已提交的检查结果保留',
  };
}

/** Mandatory at every catalog consumer registration. New business execution
 * requires a server reservation; exact terminal metadata only replays a result,
 * never starts work or proves that a physical transaction has settled. */
export function createCatalogFencedProcessor(
  taskType: CatalogTaskBinding['taskType'],
  repository: PgCatalogOperationRepository,
  store: Pick<RedisTaskRepository, 'read'>,
  processor: Processor<unknown, unknown, string>,
  log: Pick<typeof logger, 'warn'> = logger,
): Processor<unknown, unknown, string> {
  return async (job, token) => {
    let task: CatalogTaskBinding, identity: CatalogOperationIdentity;
    try {
      task = binding(job, taskType);
      const state = await store.read(task.taskId);
      if (!sameTask(state, task) || !state)
        throw new CatalogOperationError('CATALOG_OPERATION_IDENTITY');
      // The original worker has already closed/released its PostgreSQL slot.
      // A lost BullMQ completion ACK must replay metadata, not prepare new work.
      if (state.status === 'completed') return completedResult(job, state);
      if (state.status === 'failed')
        throw new UnrecoverableError('目录任务已失败，请核实已提交结果');
      try {
        identity = await repository.findByTask(task);
      } catch (error) {
        if (
          state.status === 'cancelled' &&
          error instanceof CatalogOperationError &&
          error.code === 'CATALOG_OPERATION_MISSING'
        )
          return cancelledResult(taskType);
        throw error;
      }
      const initial = requireSnapshot(
        await repository.read(identity.ownerId, identity.domain),
        identity,
        task,
      );
      if (state.status === 'cancelled') {
        // The cancelling API may have removed the exact queue job and closed
        // its generation. Preserve that first proof; never restart its work.
        if (
          initial.state === 'closed' &&
          initial.terminal?.status === 'cancelled' &&
          ['cancel', 'worker'].includes(initial.terminal.source) &&
          sameTask(initial.terminal.task ?? null, task)
        ) {
          if (!initial.pendingPins && !initial.uncertainPins) {
            await repository.close(identity);
            await repository.release(identity);
          }
        }
        // Terminal Redis metadata cannot start another processor, settle an
        // open/uncertain generation, or clear a still-pending physical pin.
        return cancelledResult(taskType);
      }
      if (initial.state !== 'open') {
        throw new CatalogOperationError(
          initial.state === 'uncertain'
            ? 'CATALOG_OPERATION_UNCERTAIN'
            : 'CATALOG_OPERATION_CLOSED',
        );
      }
      if (initial.uncertainPins)
        throw new CatalogOperationError('CATALOG_OPERATION_UNCERTAIN');
      if (initial.pendingPins)
        throw new CatalogOperationError('CATALOG_OPERATION_DEPENDENCY');
    } catch (error) {
      log.warn('目录任务执行身份未确认', {
        reason: 'catalog_task_admission_failed',
        taskType,
      });
      throw rejected(error);
    }
    let actionDone = false,
      unconfirmed = false,
      released = false,
      allocating = 0;
    const pins = new Set<string>();
    let settlement: Promise<void> = Promise.resolve();
    const settle = () => {
      settlement = settlement
        .then(async () => {
          if (!actionDone || released || unconfirmed || allocating || pins.size)
            return;
          const current = await store.read(task.taskId);
          if (
            !sameTask(current, task) ||
            !current ||
            !['completed', 'failed', 'cancelled'].includes(current.status)
          )
            return;
          const snapshot = requireSnapshot(
            await repository.read(identity.ownerId, identity.domain),
            identity,
            task,
          );
          if (
            snapshot.state === 'uncertain' ||
            snapshot.pendingPins ||
            snapshot.uncertainPins
          )
            return;
          if (snapshot.terminal) {
            if (
              snapshot.terminal.status !== current.status ||
              !['worker', 'cancel'].includes(snapshot.terminal.source) ||
              !sameTask(snapshot.terminal.task ?? null, task)
            )
              throw new CatalogOperationError('CATALOG_OPERATION_IDENTITY');
            await repository.close(identity);
          } else {
            await repository.close(identity, {
              status: current.status as 'completed' | 'failed' | 'cancelled',
              source: 'worker',
              task,
            });
          }
          released = await repository.release(identity);
        })
        .catch(() => {
          // Preserve the original processor's result/error. The durable slot and
          // pin ledger remain the authority even if this acknowledgement is lost.
          log.warn('目录任务释放未确认', {
            reason: 'catalog_task_settlement_unconfirmed',
            taskType,
          });
        });
      return settlement;
    };
    // Transaction helpers invoke these methods from their real physical
    // finally, after COMMIT/ROLLBACK ACK and connection release. Capturing each
    // job separately prevents a timed-out promise from freeing another run.
    const observed = new Proxy(repository, {
      get(target, property) {
        if (property === 'beginPin')
          return async (value: CatalogOperationIdentity) => {
            if (actionDone)
              throw new CatalogOperationError('CATALOG_OPERATION_CLOSED');
            if (unconfirmed)
              throw new CatalogOperationError('CATALOG_OPERATION_UNCERTAIN');
            if (!sameIdentity(value, identity))
              throw new CatalogOperationError('CATALOG_OPERATION_IDENTITY');
            allocating++;
            try {
              const pin = await target.beginPin(value);
              pins.add(pin.pinId);
              return pin;
            } catch (error) {
              // A lost allocation ACK may conceal a committed pending pin. No
              // snapshot taken while its transaction is still running proves none.
              unconfirmed = true;
              throw error;
            } finally {
              allocating--;
            }
          };
        if (property === 'assertPin')
          return async (
            db: Parameters<PgCatalogOperationRepository['assertPin']>[0],
            pin: CatalogOperationPin,
          ) => {
            if (actionDone)
              throw new CatalogOperationError('CATALOG_OPERATION_CLOSED');
            if (unconfirmed)
              throw new CatalogOperationError('CATALOG_OPERATION_UNCERTAIN');
            if (!sameIdentity(pin.identity, identity) || !pins.has(pin.pinId))
              throw new CatalogOperationError('CATALOG_OPERATION_IDENTITY');
            return target.assertPin(db, pin);
          };
        if (property === 'finishPin')
          return async (
            pin: CatalogOperationPin,
            outcome: CatalogPhysicalOutcome,
          ) => {
            if (!sameIdentity(pin.identity, identity) || !pins.has(pin.pinId))
              throw new CatalogOperationError('CATALOG_OPERATION_IDENTITY');
            try {
              await target.finishPin(pin, outcome);
              if (outcome === 'uncertain') unconfirmed = true;
              else pins.delete(pin.pinId);
            } catch (error) {
              unconfirmed = true;
              throw error;
            } finally {
              if (actionDone) await settle();
            }
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      return await withCatalogOperationExecution(observed, identity, () =>
        processor(job, token),
      );
    } finally {
      // Reject any later chunk/pin from an asynchronous continuation of this
      // attempt. Already-begun physical transactions keep the gate until settled.
      actionDone = true;
      await settle();
    }
  };
}
