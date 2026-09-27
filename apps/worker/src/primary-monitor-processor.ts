import type {
  PrimaryMonitorJob,
  VariantGroupCheckData,
} from '@asin-monitor/contracts';
import { primaryMonitorJobSchema } from '@asin-monitor/contracts';
import {
  createVariantCheckOperation,
  isTerminalTaskStatus,
  VariantCheckError,
  type PgPrimaryMonitorRepository,
  type RedisTaskRepository,
  type TaskState,
} from '@asin-monitor/db';
import {
  NOTIFICATION_MAX_ITEMS,
  NOTIFICATION_MAX_TEXT_BYTES,
  NotificationError,
  snapshotNotification,
  type FeishuNotifications,
  type NotificationData,
} from '@asin-monitor/notify';
import type { VariantCheckPipeline } from '@asin-monitor/variant-check';
import { UnrecoverableError, type Job, type Processor } from 'bullmq';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { logger } from './logger';

export function monitorGroupOperation(job: PrimaryMonitorJob, groupId: string) {
  const digest = createHash('sha256')
    .update(groupId)
    .digest('hex')
    .slice(0, 24);
  return createVariantCheckOperation(
    {
      taskId: job.taskId,
      userId: job.userId,
      taskCreatedAt: job.createdAt,
      taskType: 'monitor',
      taskSubType: 'primary',
      step: `monitor-${digest}`,
      resultKind: 'group',
      expiresAt: job.expiresAt,
    },
    { groupId, forceRefresh: false },
  );
}

interface MonitorProcessorOptions {
  pipeline: Pick<VariantCheckPipeline, 'checkGroup'>;
  repository: Pick<
    PgPrimaryMonitorRepository,
    'groups' | 'claimNotification' | 'completeNotification'
  >;
  store: Pick<RedisTaskRepository, 'read' | 'mutate'>;
  notifications: Pick<FeishuNotifications, 'sendCountry'>;
  shutdownSignal: AbortSignal;
  assertJobLock(job: Job, token: string | undefined): Promise<void>;
  updateProgress(job: Job, progress: number): Promise<void>;
}

type CountrySummary = NotificationData & {
  totalGroups: number;
  brokenGroups: number;
  notificationItems: number;
  notificationTextBytes: number;
};
class MonitorNotificationCapacityError extends Error {
  constructor() {
    super('MONITOR_NOTIFICATION_CAPACITY');
  }
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const string = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
const emptyCountry = (): CountrySummary => {
  const checkTime = new Date().toISOString();
  return {
    totalGroups: 0,
    brokenGroups: 0,
    brokenGroupNames: [],
    brokenGroupDetails: [],
    brokenASINs: [],
    brokenByType: { SP_API_ERROR: 0, NOT_FOUND: 0, NO_VARIANTS: 0 },
    checkTime,
    notificationItems: 0,
    notificationTextBytes: Buffer.byteLength(checkTime),
  };
};

function reserveNotification(
  summary: CountrySummary,
  items: number,
  fields: (string | undefined)[],
) {
  const textBytes = fields.reduce(
    (total, field) => total + (field ? Buffer.byteLength(field) : 0),
    0,
  );
  if (
    summary.notificationItems + items > NOTIFICATION_MAX_ITEMS ||
    summary.notificationTextBytes + textBytes > NOTIFICATION_MAX_TEXT_BYTES
  )
    throw new MonitorNotificationCapacityError();
  summary.notificationItems += items;
  summary.notificationTextBytes += textBytes;
}

function validateNotificationSummary(
  summary: CountrySummary,
): NotificationData {
  try {
    return snapshotNotification(summary);
  } catch (error) {
    if (error instanceof NotificationError && error.reason === 'invalid-input')
      throw new MonitorNotificationCapacityError();
    throw error;
  }
}

function addGroup(summary: CountrySummary, result: VariantGroupCheckData) {
  const group = record(result.groupSnapshot);
  const groupId = string(group.id);
  const groupName = string(group.name);
  if (!groupId || !groupName) throw new Error('MONITOR_GROUP_RESULT_INVALID');
  const children = Array.isArray(group.children)
    ? group.children.map(record)
    : [];
  summary.totalGroups++;
  if (result.isBroken) {
    const statusSource = string(group.statusSource);
    const manualBrokenReason = string(group.manualBrokenReason);
    reserveNotification(summary, 2, [
      groupName,
      groupId,
      groupName,
      statusSource,
      manualBrokenReason,
    ]);
    summary.brokenGroups++;
    summary.brokenGroupNames!.push(groupName);
    summary.brokenGroupDetails!.push({
      variantGroupId: groupId,
      groupName,
      statusSource,
      manualBrokenReason,
    });
  }
  for (const code of ['SP_API_ERROR', 'NOT_FOUND', 'NO_VARIANTS'] as const)
    summary.brokenByType![code] =
      (summary.brokenByType![code] ?? 0) + count(result.brokenByType?.[code]);
  if (group.feishuNotifyEnabled === 0) return;
  const childByAsin = new Map<string, Record<string, unknown>>();
  for (const child of children) {
    const asin = string(child.asin);
    if (asin && !childByAsin.has(asin)) childByAsin.set(asin, child);
  }
  for (const asin of result.brokenASINs ?? []) {
    const asinCode = string(asin.asin);
    const child = asinCode ? childByAsin.get(asinCode) : undefined;
    if (child?.feishuNotifyEnabled === 0) continue;
    const item = {
      asin: asinCode,
      brand: string(child?.brand),
      variantGroupId: groupId,
      groupName,
      statusSource: string(asin.statusSource),
      manualBrokenReason: string(asin.manualBrokenReason),
    };
    reserveNotification(summary, 1, [
      item.variantGroupId,
      item.groupName,
      item.statusSource,
      item.manualBrokenReason,
      item.asin,
      item.brand,
    ]);
    summary.brokenASINs!.push(item);
  }
}

/** A receipt and its GROUP/ASIN history share one PostgreSQL commit. The
 * country notification is claimed before external I/O, so an uncertain send
 * is surfaced for reconciliation instead of repeated after a crash. */
export function createPrimaryMonitorProcessor(
  options: MonitorProcessorOptions,
): Processor<unknown, unknown, string> {
  return async (job, token) => {
    const parsed = primaryMonitorJobSchema.safeParse(job.data);
    if (
      !parsed.success ||
      job.id !== parsed.data.taskId ||
      job.name !== 'primary-monitor'
    )
      throw new UnrecoverableError('监控任务数据无效');
    const data = parsed.data;
    const controller = new AbortController();
    const shutdown = () =>
      controller.abort(new Error('MONITOR_WORKER_SHUTDOWN'));
    options.shutdownSignal.addEventListener('abort', shutdown, { once: true });
    if (options.shutdownSignal.aborted) shutdown();
    const identity = {
      userId: data.userId,
      taskType: data.taskType,
      taskSubType: data.taskSubType,
      createdAt: data.createdAt,
    };
    const check = async (): Promise<TaskState> => {
      controller.signal.throwIfAborted();
      await options.assertJobLock(job, token);
      const state = await options.store.read(data.taskId);
      if (
        !state ||
        state.taskId !== data.taskId ||
        state.userId !== data.userId ||
        state.taskType !== data.taskType ||
        state.taskSubType !== data.taskSubType ||
        state.createdAt !== data.createdAt ||
        Date.parse(data.expiresAt) <= Date.now()
      )
        throw new Error('MONITOR_TASK_IDENTITY_INVALID');
      if (
        state.cancelRequestedAt ||
        ['cancelling', 'cancelled'].includes(state.status)
      )
        throw new Error('MONITOR_CANCELLED');
      if (isTerminalTaskStatus(state.status))
        throw new Error('MONITOR_ALREADY_TERMINAL');
      return state;
    };
    let committed = false;
    let finalResult: Record<string, unknown> | undefined;
    let cancellationAccepted = false;
    try {
      await check();
      await options.store.mutate(
        data.taskId,
        { kind: 'processing', message: '监控任务开始处理' },
        identity,
      );
      const groups = await options.repository.groups(data);
      const countryResults = Object.fromEntries(
        data.countries.map((country) => [country, emptyCountry()]),
      ) as Record<string, CountrySummary>;
      let completed = 0;
      let failedGroups = 0;
      for (const country of data.countries) {
        for (const group of groups.filter((item) => item.country === country)) {
          await check();
          try {
            const result = await options.pipeline.checkGroup(group.groupId, {
              signal: controller.signal,
              operation: monitorGroupOperation(data, group.groupId),
              validateResult: (value) => {
                const snapshot = (value as VariantGroupCheckData).groupSnapshot;
                if (
                  typeof snapshot?.country !== 'string' ||
                  snapshot.country.replace(/ +$/, '').toUpperCase() !== country
                )
                  throw new VariantCheckError('snapshot-changed');
              },
              authorize: async () => {
                await check();
              },
              checkpoint: async () => {
                await check();
              },
            });
            committed = true;
            addGroup(countryResults[country], result);
            // Stop before the next history commit when a country can no
            // longer fit the exact untruncated notification contract.
            validateNotificationSummary(countryResults[country]);
          } catch (error) {
            if (
              !(error instanceof VariantCheckError) ||
              !['group-not-found', 'snapshot-changed'].includes(error.code)
            )
              throw error;
            failedGroups++;
            logger.warn('监控变体组快照已变化', {
              reason: 'monitor_group_snapshot_changed',
            });
          }
          completed++;
          const progress = Math.min(
            90,
            5 + Math.floor((completed / Math.max(groups.length, 1)) * 85),
          );
          await check();
          await options.store.mutate(
            data.taskId,
            {
              kind: 'progress',
              progress,
              message: `已检查 ${completed}/${groups.length} 个变体组`,
            },
            identity,
          );
          await options.updateProgress(job, progress);
        }
        countryResults[country].checkTime = new Date().toISOString();
      }
      if (failedGroups) throw new Error('MONITOR_GROUPS_INCOMPLETE');
      // Validate every bounded payload before the first notification claim.
      // A rejected payload can then be retried without an uncertain send.
      const notificationSnapshots = Object.fromEntries(
        data.countries.map((country) => [
          country,
          validateNotificationSummary(countryResults[country]),
        ]),
      ) as Record<string, NotificationData>;
      const notificationResults: Record<string, string> = {};
      for (let index = 0; index < data.countries.length; index++) {
        await check();
        const country = data.countries[index];
        const claim = await options.repository.claimNotification(
          data.taskId,
          country,
        );
        if (claim === 'new') {
          const outcome = await options.notifications.sendCountry(
            'primary',
            country,
            notificationSnapshots[country],
            controller.signal,
          );
          await options.repository.completeNotification(
            data.taskId,
            country,
            outcome.success,
          );
          notificationResults[country] = outcome.success ? 'sent' : 'failed';
        } else {
          notificationResults[country] =
            claim === 'claimed' ? 'unconfirmed' : claim;
        }
        if (index + 1 < data.countries.length)
          await delay(500, undefined, { signal: controller.signal });
      }
      const totalChecked = Object.values(countryResults).reduce(
        (n, row) => n + row.totalGroups,
        0,
      );
      const totalBroken = Object.values(countryResults).reduce(
        (n, row) => n + row.brokenGroups,
        0,
      );
      const result = {
        success: true,
        totalChecked,
        totalBroken,
        totalNormal: totalChecked - totalBroken,
        countryResults: Object.fromEntries(
          data.countries.map((country) => [
            country,
            {
              totalGroups: countryResults[country].totalGroups,
              brokenGroups: countryResults[country].brokenGroups,
            },
          ]),
        ),
        notificationResults,
      };
      // All PostgreSQL receipts and country notification claims are already
      // committed. A failed Redis acknowledgement must not reclassify this
      // fully completed business run as a definitive failure.
      finalResult = result;
      await check();
      const state = await options.store.mutate(
        data.taskId,
        { kind: 'completed', result, message: '监控任务已完成' },
        identity,
      );
      if (
        state?.cancelRequestedAt ||
        state?.status === 'cancelling' ||
        state?.status === 'cancelled'
      ) {
        cancellationAccepted = true;
        if (state.status !== 'cancelled')
          await options.store.mutate(
            data.taskId,
            { kind: 'cancelled', message: '监控任务已取消，已提交的结果保留' },
            identity,
          );
        return { cancelled: true };
      }
      if (state?.status !== 'completed')
        throw new Error('MONITOR_FINAL_STATUS_UNCONFIRMED');
      logger.info('主营监控任务完成', { totalChecked, totalBroken });
      return result;
    } catch (error) {
      const cancelled =
        error instanceof Error && error.message === 'MONITOR_CANCELLED';
      const capacity = error instanceof MonitorNotificationCapacityError;
      if (finalResult && !cancelled) {
        // BullMQ persists the returned result; the task query reconciler can
        // recover the Redis task state from that owned completed queue job.
        logger.warn('监控业务已完成，最终任务状态待对账', {
          reason: 'monitor_final_status_unconfirmed',
        });
        return cancellationAccepted ? { cancelled: true } : finalResult;
      }
      const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      let cancelledAfterError = cancelled;
      try {
        await options.assertJobLock(job, token);
        const state = await options.store.read(data.taskId);
        if (state && !isTerminalTaskStatus(state.status)) {
          if (cancelled || state.cancelRequestedAt) {
            cancelledAfterError = true;
            await options.store.mutate(
              data.taskId,
              {
                kind: 'cancelled',
                message: '监控任务已取消，已提交的结果保留',
              },
              identity,
            );
          } else if (
            (capacity || finalAttempt) &&
            !options.shutdownSignal.aborted
          )
            await options.store.mutate(
              data.taskId,
              {
                kind: 'failed',
                message: capacity
                  ? '监控通知摘要超出容量，请核实已提交结果'
                  : '监控任务失败，请核实已提交结果',
              },
              identity,
            );
        }
      } catch {
        logger.warn('监控任务状态写入未确认', {
          reason: 'monitor_status_unconfirmed',
        });
      }
      if (cancelledAfterError) return { cancelled: true };
      if (capacity) {
        logger.error('主营监控通知容量超限', {
          reason: 'monitor_notification_capacity',
        });
        throw new UnrecoverableError('监控通知摘要超出容量，请核实已提交结果');
      }
      logger.warn('主营监控等待重试或对账', {
        reason: committed
          ? 'monitor_partial_commit'
          : 'monitor_attempt_interrupted',
      });
      throw new Error('监控任务未完成');
    } finally {
      options.shutdownSignal.removeEventListener('abort', shutdown);
    }
  };
}
