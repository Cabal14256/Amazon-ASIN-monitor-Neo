import {
  competitorMonitorJobSchema,
  type CompetitorMonitorJob,
} from '@asin-monitor/contracts';
import {
  assertCompetitorMonitorControl,
  competitorMonitorJobDigest,
  createVariantCheckOperation,
  isTerminalTaskStatus,
  parseCompetitorMonitorCompletion,
  VariantCheckError,
  type CompetitorMonitorControlUnit,
  type CompetitorMonitorGroup,
  type CompetitorMonitorNotificationCandidate,
  type PgCompetitorMonitorRepository,
  type RedisTaskRepository,
  type TaskState,
} from '@asin-monitor/db';
import {
  NOTIFICATION_MAX_ITEMS,
  NOTIFICATION_MAX_TEXT_BYTES,
  snapshotNotification,
  validateCountryNotification,
  type FeishuNotifications,
  type NotificationData,
} from '@asin-monitor/notify';
import type {
  CompetitorCheckPipeline,
  CompetitorGroupCheckData,
} from '@asin-monitor/variant-check';
import { UnrecoverableError, type Job, type Processor } from 'bullmq';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { logger } from './logger';

export function competitorMonitorGroupOperation(
  job: CompetitorMonitorJob,
  group: CompetitorMonitorGroup,
) {
  const digest = createHash('sha256')
    .update(group.groupId)
    .digest('hex')
    .slice(0, 24);
  return createVariantCheckOperation(
    {
      taskId: job.taskId,
      userId: job.userId,
      taskCreatedAt: job.createdAt,
      taskType: 'competitor-monitor',
      taskSubType: 'competitor',
      step: `monitor-${digest}`,
      resultKind: 'competitor-group',
      expiresAt: job.expiresAt,
    },
    {
      groupId: group.groupId,
      forceRefresh: false,
      snapshotDigest: group.snapshotDigest,
    },
  );
}
interface Options {
  pipeline: Pick<CompetitorCheckPipeline, 'checkGroup'>;
  repository: Pick<
    PgCompetitorMonitorRepository,
    | 'groups'
    | 'control'
    | 'readNotification'
    | 'assertNotificationInputs'
    | 'claimNotification'
    | 'completeNotification'
  >;
  store: Pick<RedisTaskRepository, 'read' | 'mutate'>;
  notifications: Pick<FeishuNotifications, 'withCompetitorCountryDelivery'>;
  defaultEnabled: boolean;
  shutdownSignal: AbortSignal;
  assertJobLock(job: Job, token: string | undefined): Promise<void>;
  updateProgress(job: Job, progress: number): Promise<void>;
}
type Summary = NotificationData & {
  totalGroups: number;
  brokenGroups: number;
  notificationItems: number;
  notificationBytes: number;
  candidates: CompetitorMonitorNotificationCandidate[];
  brokenByType: {
    SP_API_ERROR: number;
    NOT_FOUND: number;
    NO_VARIANTS: number;
  };
  checkTime: string;
};
const empty = (job: CompetitorMonitorJob): Summary => ({
  totalGroups: 0,
  brokenGroups: 0,
  brokenGroupNames: [],
  brokenGroupDetails: [],
  brokenASINs: [],
  brokenByType: { SP_API_ERROR: 0, NOT_FOUND: 0, NO_VARIANTS: 0 },
  checkTime: job.createdAt,
  notificationItems: 0,
  notificationBytes: Buffer.byteLength(job.createdAt),
  candidates: [],
});
class SummaryCapacity extends Error {}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown) =>
  typeof value === 'string' ? value : undefined;
function reserve(
  summary: Summary,
  items: number,
  fields: (string | undefined)[],
) {
  const bytes = fields.reduce(
    (sum, value) => sum + (value ? Buffer.byteLength(value) : 0),
    0,
  );
  if (
    summary.notificationItems + items > NOTIFICATION_MAX_ITEMS ||
    summary.notificationBytes + bytes > NOTIFICATION_MAX_TEXT_BYTES
  )
    throw new SummaryCapacity();
  summary.notificationItems += items;
  summary.notificationBytes += bytes;
}
function addGroup(
  summary: Summary,
  result: CompetitorGroupCheckData,
  group: CompetitorMonitorGroup,
) {
  const snapshot = record(result.groupSnapshot);
  if (
    snapshot.id !== group.groupId ||
    typeof snapshot.country !== 'string' ||
    snapshot.country.replace(/ +$/, '').toUpperCase() !== group.country
  )
    throw new VariantCheckError('snapshot-changed');
  summary.totalGroups++;
  if (result.isBroken) summary.brokenGroups++;
  for (const code of ['SP_API_ERROR', 'NOT_FOUND', 'NO_VARIANTS'] as const)
    summary.brokenByType[code] += result.brokenByType[code];
  // Null/missing Legacy flags also default off; both persisted switches must be on.
  if (snapshot.feishuNotifyEnabled !== 1) return;
  const children = Array.isArray(snapshot.children)
    ? snapshot.children.map(record)
    : [];
  // A group can contain the same code in different countries. Notification
  // identity follows the committed canonical child, never a code-only map.
  const enabled = children.filter(
    (child) =>
      child.isBroken === 1 &&
      child.feishuNotifyEnabled === 1 &&
      typeof child.country === 'string' &&
      child.country.replace(/ +$/, '').toUpperCase() === group.country,
  );
  if (!enabled.length) return;
  const name = text(snapshot.name);
  if (name === undefined) throw new Error('COMPETITOR_MONITOR_RESULT_INVALID');
  reserve(summary, 2, [name, group.groupId, name]);
  summary.brokenGroupNames!.push(name);
  summary.brokenGroupDetails!.push({
    variantGroupId: group.groupId,
    groupName: name,
  });
  for (const child of enabled) {
    if (
      typeof child.id !== 'string' ||
      typeof child.asin !== 'string' ||
      (typeof snapshot.createTime !== 'string' &&
        snapshot.createTime !== null) ||
      (typeof child.createTime !== 'string' && child.createTime !== null) ||
      (typeof child.brand !== 'string' && child.brand !== null)
    )
      throw new Error('COMPETITOR_MONITOR_RESULT_INVALID');
    const item = {
      asin: child.asin,
      brand: text(child.brand),
      variantGroupId: group.groupId,
      groupName: name,
    };
    reserve(summary, 1, [item.asin, item.brand, group.groupId, name]);
    summary.brokenASINs!.push(item);
    summary.candidates.push({
      groupId: group.groupId,
      groupName: name,
      groupCreatedAt: snapshot.createTime as string | null,
      asinId: child.id,
      asin: child.asin,
      brand: child.brand as string | null,
      asinCreatedAt: child.createTime as string | null,
    });
  }
}
/** Independent competitor identity, frozen catalog and same-transaction group
 * receipts/history. Country claims survive restart and uncertain external sends. */
export function createCompetitorMonitorProcessor(
  options: Options,
): Processor<unknown, unknown, string> {
  return async (job, token) => {
    const parsed = competitorMonitorJobSchema.safeParse(job.data);
    if (
      !parsed.success ||
      job.id !== parsed.data.taskId ||
      job.name !== 'competitor-monitor'
    )
      throw new UnrecoverableError('竞品监控任务数据无效');
    const data = parsed.data;
    const identity = {
      userId: data.userId,
      taskType: data.taskType,
      taskSubType: data.taskSubType,
      createdAt: data.createdAt,
    };
    const controller = new AbortController();
    const shutdown = () =>
      controller.abort(new Error('COMPETITOR_MONITOR_SHUTDOWN'));
    options.shutdownSignal.addEventListener('abort', shutdown, { once: true });
    if (options.shutdownSignal.aborted) shutdown();
    let heartbeat: ReturnType<typeof setTimeout> | undefined,
      checking: Promise<void> | undefined;
    let stopped = false,
      committed = false,
      finalResult:
        | ReturnType<typeof parseCompetitorMonitorCompletion>
        | undefined;
    const cancelled = new Error('COMPETITOR_MONITOR_CANCELLED');
    const verify = (state: TaskState | null): TaskState => {
      if (
        !state ||
        state.taskId !== data.taskId ||
        state.userId !== data.userId ||
        state.taskType !== data.taskType ||
        state.taskSubType !== data.taskSubType ||
        state.createdAt !== data.createdAt
      )
        throw new Error('COMPETITOR_MONITOR_IDENTITY_INVALID');
      return state;
    };
    const check = async () => {
      controller.signal.throwIfAborted();
      await options.assertJobLock(job, token);
      const state = verify(await options.store.read(data.taskId));
      if (
        state.cancelRequestedAt ||
        ['cancelling', 'cancelled'].includes(state.status)
      )
        throw cancelled;
      if (isTerminalTaskStatus(state.status))
        throw new Error('COMPETITOR_MONITOR_TERMINAL');
      if (Date.parse(data.expiresAt) <= Date.now())
        throw new VariantCheckError('operation-expired');
      controller.signal.throwIfAborted();
      return state;
    };
    const authorize = async (unit: CompetitorMonitorControlUnit) => {
      await check();
      await assertCompetitorMonitorControl(
        unit,
        data.userId,
        options.defaultEnabled,
      );
      controller.signal.throwIfAborted();
    };
    const preflight = async () => {
      await check();
      await options.repository.control(authorize, controller.signal);
      await check();
    };
    const schedule = () => {
      if (stopped || controller.signal.aborted) return;
      heartbeat = setTimeout(() => {
        checking = check()
          .then(() => {})
          .catch((error) => controller.abort(error));
        void checking.then(schedule);
      }, 1000);
      heartbeat.unref();
    };
    try {
      const state = verify(await options.store.read(data.taskId));
      if (state.status === 'completed')
        return parseCompetitorMonitorCompletion(data, state.result);
      await preflight();
      schedule();
      verify(
        await options.store.mutate(
          data.taskId,
          { kind: 'processing', message: '竞品监控任务开始处理' },
          identity,
        ),
      );
      const groups = await options.repository.groups(
        data,
        authorize,
        controller.signal,
      );
      const countryResults = Object.fromEntries(
        data.countries.map((country) => [country, empty(data)]),
      ) as Record<string, Summary>;
      let complete = 0;
      for (const country of data.countries) {
        for (const group of groups.filter((item) => item.country === country)) {
          await check();
          const result = await options.pipeline.checkGroup(group.groupId, {
            forceRefresh: false,
            snapshotDigest: group.snapshotDigest,
            operation: competitorMonitorGroupOperation(data, group),
            signal: controller.signal,
            authorize: async (unit) => {
              if (!unit.competitorMonitorConfiguration)
                throw new Error('COMPETITOR_MONITOR_CONTROL_UNAVAILABLE');
              await authorize({
                ...unit,
                competitorMonitorConfiguration:
                  unit.competitorMonitorConfiguration,
              });
            },
            checkpoint: async () => {
              await check();
            },
          });
          committed = true;
          addGroup(countryResults[country], result, group);
          complete++;
          try {
            validateCountryNotification(
              'competitor',
              country,
              snapshotNotification(countryResults[country]),
            );
          } catch {
            throw new SummaryCapacity();
          }
          const progress = Math.min(
            90,
            5 + Math.floor((85 * complete) / Math.max(groups.length, 1)),
          );
          await check();
          verify(
            await options.store.mutate(
              data.taskId,
              {
                kind: 'progress',
                progress,
                message: `已检查 ${complete}/${groups.length} 个竞品组`,
              },
              identity,
            ),
          );
          await options.updateProgress(job, progress);
        }
      }
      const notificationResults: Record<
        string,
        'sent' | 'failed' | 'unconfirmed' | 'skipped'
      > = {};
      let attemptedCountry = false;
      for (const country of data.countries) {
        const summary = countryResults[country];
        notificationResults[country] = 'skipped';
        await check();
        const previous = await options.repository.readNotification(
          data,
          country,
          authorize,
          controller.signal,
        );
        await check();
        if (previous) {
          notificationResults[country] =
            previous === 'claimed' ? 'unconfirmed' : previous;
          continue;
        }
        if (!summary.brokenASINs?.length) continue;
        if (attemptedCountry)
          await delay(500, undefined, { signal: controller.signal });
        attemptedCountry = true;
        const deliveryPreflight = async () => {
          await check();
          await options.repository.assertNotificationInputs(
            data,
            country,
            summary.candidates,
            authorize,
            controller.signal,
          );
          await check();
        };
        await deliveryPreflight();
        await options.notifications.withCompetitorCountryDelivery(
          country,
          snapshotNotification(summary),
          async (send) => {
            await deliveryPreflight();
            const claim = await options.repository.claimNotification(
              data,
              country,
              summary.candidates,
              authorize,
              controller.signal,
            );
            if (claim !== 'new') {
              notificationResults[country] =
                claim === 'claimed' ? 'unconfirmed' : claim;
              return;
            }
            const outcome = await send();
            if (outcome.unconfirmed) {
              notificationResults[country] = 'unconfirmed';
              return;
            }
            await options.repository.completeNotification(
              data,
              country,
              outcome.success,
              authorize,
              controller.signal,
            );
            notificationResults[country] = outcome.success ? 'sent' : 'failed';
          },
          deliveryPreflight,
          controller.signal,
        );
      }
      const totalChecked = Object.values(countryResults).reduce(
        (sum, row) => sum + row.totalGroups,
        0,
      );
      const totalBroken = Object.values(countryResults).reduce(
        (sum, row) => sum + row.brokenGroups,
        0,
      );
      finalResult = parseCompetitorMonitorCompletion(data, {
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
              brokenByType: countryResults[country].brokenByType,
              checkTime: data.createdAt,
            },
          ]),
        ),
        notificationResults,
        _competitorMonitorCommit: {
          version: 1,
          requestHash: competitorMonitorJobDigest(data),
        },
      });
      await check();
      const finished = verify(
        await options.store.mutate(
          data.taskId,
          {
            kind: 'completed',
            result: finalResult,
            message: '竞品监控任务完成',
          },
          identity,
        ),
      );
      if (
        finished.cancelRequestedAt ||
        ['cancelling', 'cancelled'].includes(finished.status)
      )
        throw cancelled;
      if (finished.status !== 'completed')
        throw new Error('COMPETITOR_MONITOR_ACK_UNCONFIRMED');
      logger.info('竞品监控任务完成', { totalChecked, totalBroken });
      return finalResult;
    } catch (error) {
      const wasCancelled =
        error === cancelled || controller.signal.reason === cancelled;
      if (finalResult && !wasCancelled) {
        logger.warn('竞品监控业务已完成，最终状态待对账', {
          reason: 'competitor_monitor_final_status_unconfirmed',
        });
        return finalResult;
      }
      const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      let cancellation = wasCancelled;
      try {
        await options.assertJobLock(job, token);
        const state = verify(await options.store.read(data.taskId));
        cancellation ||=
          !!state.cancelRequestedAt ||
          ['cancelling', 'cancelled'].includes(state.status);
        if (!isTerminalTaskStatus(state.status)) {
          if (cancellation)
            await options.store.mutate(
              data.taskId,
              {
                kind: 'cancelled',
                message: '竞品监控任务已取消，已提交的结果保留',
              },
              identity,
            );
          else if (
            (error instanceof SummaryCapacity || finalAttempt) &&
            !options.shutdownSignal.aborted
          )
            await options.store.mutate(
              data.taskId,
              {
                kind: 'failed',
                message:
                  error instanceof SummaryCapacity
                    ? '竞品通知摘要超出容量，请核实已提交结果'
                    : '竞品监控未完成，请核实最新目录和已提交结果',
              },
              identity,
            );
        }
      } catch {
        logger.warn('竞品监控状态写入未确认', {
          reason: 'competitor_monitor_status_unconfirmed',
        });
      }
      if (cancellation) return { cancelled: true };
      logger.warn('竞品监控等待重试或对账', {
        reason: committed
          ? 'competitor_monitor_partial_commit'
          : 'competitor_monitor_attempt_interrupted',
      });
      if (error instanceof SummaryCapacity)
        throw new UnrecoverableError('竞品通知摘要超出容量，请核实已提交结果');
      throw new Error('竞品监控任务未完成');
    } finally {
      stopped = true;
      if (heartbeat) clearTimeout(heartbeat);
      await checking;
      options.shutdownSignal.removeEventListener('abort', shutdown);
    }
  };
}
