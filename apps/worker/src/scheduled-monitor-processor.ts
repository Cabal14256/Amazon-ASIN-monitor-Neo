import type { ScheduledMonitorJob } from '@asin-monitor/contracts';
import {
  evaluateScheduledMonitorFreshness,
  parseScheduledMonitorJob,
  ScheduledMonitorRunError,
  type PgCompetitorScheduledMonitorRunRepository,
  type PgPrimaryScheduledMonitorRunRepository,
  type ScheduledMonitorCheck,
  type ScheduledMonitorRun,
} from '@asin-monitor/db';
import type {
  VariantCheckPipeline,
  VariantGroupAdmission,
} from '@asin-monitor/variant-check';
import { UnrecoverableError, type Job, type Processor } from 'bullmq';
import { logger } from './logger';

type Ledger = Pick<
  | PgPrimaryScheduledMonitorRunRepository
  | PgCompetitorScheduledMonitorRunRepository,
  | 'accept'
  | 'read'
  | 'start'
  | 'readGroupReceipt'
  | 'finishWithoutBusiness'
  | 'completeBusiness'
  | 'complete'
>;

export interface ScheduledMonitorProcessorOptions {
  primary: Ledger;
  competitor: Ledger;
  primaryPipeline: Pick<VariantCheckPipeline, 'checkGroup'>;
  competitorPipeline: Pick<
    import('@asin-monitor/variant-check').CompetitorCheckPipeline,
    'checkGroup'
  >;
  groupAdmission?: VariantGroupAdmission;
  shutdownSignal: AbortSignal;
  assertJobLock(job: Job, token: string | undefined): Promise<void>;
  enqueueFollowUp(job: ScheduledMonitorJob): Promise<void>;
  deliverNotifications?(
    run: ScheduledMonitorRun,
    signal: AbortSignal,
    checkpoint?: () => Promise<void>,
  ): Promise<void>;
  maxAgeMs?: number;
}

function ledgerFor(
  job: ScheduledMonitorJob,
  options: ScheduledMonitorProcessorOptions,
) {
  return job.domain === 'primary' ? options.primary : options.competitor;
}

function resultCounts(value: unknown): {
  brokenGroups: number;
  brokenMembers: number;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ScheduledMonitorRunError('identity');
  const row = value as Record<string, unknown>;
  const brokenMembers = Array.isArray(row.brokenASINs)
    ? row.brokenASINs.length
    : 0;
  if (typeof row.isBroken !== 'boolean')
    throw new ScheduledMonitorRunError('identity');
  return { brokenGroups: row.isBroken ? 1 : 0, brokenMembers };
}

function isCancellation(error: unknown): boolean {
  return (
    error instanceof ScheduledMonitorRunError &&
    (error.code === 'cancelled' || error.code === 'expired')
  );
}

function commitMayHaveSucceeded(error: unknown): boolean {
  return (
    (typeof error === 'object' &&
      error !== null &&
      (error as { commitMayHaveSucceeded?: unknown }).commitMayHaveSucceeded ===
        true) ||
    (error instanceof ScheduledMonitorRunError &&
      error.code === 'commit-uncertain')
  );
}

/** Private system consumer. It never writes Redis task metadata or uses the
 * public task list; the PostgreSQL ledger is the sole recovery identity. */
export function createScheduledMonitorProcessor(
  options: ScheduledMonitorProcessorOptions,
): Processor<unknown, ScheduledMonitorRun, string> {
  return async (bullJob, token) => {
    let job: ScheduledMonitorJob;
    try {
      job = parseScheduledMonitorJob(bullJob.data);
    } catch {
      throw new UnrecoverableError('定时监控任务身份无效');
    }
    if (
      bullJob.name !== 'scheduled-monitor' ||
      typeof bullJob.id !== 'string' ||
      bullJob.id !== job.jobId
    )
      throw new UnrecoverableError('定时监控队列身份无效');
    const ledger = ledgerFor(job, options);
    const controller = new AbortController();
    const onShutdown = () =>
      controller.abort(new ScheduledMonitorRunError('cancelled'));
    options.shutdownSignal.addEventListener('abort', onShutdown, {
      once: true,
    });
    if (options.shutdownSignal.aborted) onShutdown();
    const signal = controller.signal;
    let heartbeat: ReturnType<typeof setTimeout> | undefined;
    let heartbeatCheck: Promise<void> | undefined;
    let heartbeatStopped = false;
    let activeRun: ScheduledMonitorRun | undefined;
    const check = async (run: ScheduledMonitorRun) => {
      signal.throwIfAborted();
      await options.assertJobLock(bullJob, token);
      const current = await ledger.read(job, signal);
      if (!current) throw new ScheduledMonitorRunError('dependency');
      if (current.cancelRequestedAt)
        throw new ScheduledMonitorRunError('cancelled');
      if (current.state === 'skipped-expired')
        throw new ScheduledMonitorRunError('expired');
      if (current.state === 'completed') return current;
      if (run.state === 'running' && current.state !== 'running')
        throw new ScheduledMonitorRunError('state');
      if (run.state === 'running') {
        const freshness = evaluateScheduledMonitorFreshness(
          job,
          undefined,
          Date.now(),
          options.maxAgeMs,
        );
        if (freshness.stale || Date.parse(job.expiresAt) <= Date.now())
          throw new ScheduledMonitorRunError('expired');
      }
      signal.throwIfAborted();
      return current;
    };

    const scheduleHeartbeat = () => {
      if (heartbeatStopped || signal.aborted || !activeRun) return;
      heartbeat = setTimeout(() => {
        if (heartbeatStopped || signal.aborted || heartbeatCheck) return;
        heartbeatCheck = check(activeRun!)
          .then(() => undefined)
          .catch((error: unknown) => {
            controller.abort(error);
          })
          .finally(() => {
            heartbeatCheck = undefined;
            scheduleHeartbeat();
          });
      }, 1000);
      heartbeat.unref();
    };
    const checkpoint = async (): Promise<void> => {
      await check(activeRun!);
    };

    let run: ScheduledMonitorRun;
    try {
      run = await ledger.accept(job, signal);
    } catch (error) {
      options.shutdownSignal.removeEventListener('abort', onShutdown);
      throw error;
    }
    if (run.state === 'skipped-expired' || run.state === 'completed') {
      options.shutdownSignal.removeEventListener('abort', onShutdown);
      return run;
    }
    if (run.state === 'business-completed') {
      try {
        // A committed business run is recovered by its immutable ledger result;
        // the freshness clock must not prevent notification/follow-up recovery.
        if (options.deliverNotifications)
          await options.deliverNotifications(run, signal, async () => {
            await options.assertJobLock(bullJob, token);
            const current = await ledger.read(job, signal);
            if (!current || current.state !== 'business-completed')
              throw new ScheduledMonitorRunError('state');
          });
        if (run.followUpJob) await options.enqueueFollowUp(run.followUpJob);
        return ledger.complete(job, signal);
      } finally {
        options.shutdownSignal.removeEventListener('abort', onShutdown);
      }
    }
    try {
      run = await ledger.start(job, signal);
      activeRun = run;
      scheduleHeartbeat();
      let brokenGroups = 0;
      let brokenMembers = 0;
      for (const group of run.groups) {
        const current = await check(run);
        const receipt = await ledger.readGroupReceipt(
          job,
          group.ordinal,
          signal,
        );
        if (receipt !== undefined) {
          const counts = resultCounts(receipt);
          brokenGroups += counts.brokenGroups;
          brokenMembers += counts.brokenMembers;
          continue;
        }
        const scheduledMonitor: ScheduledMonitorCheck = { job, group };
        try {
          const result =
            job.domain === 'primary'
              ? await options.primaryPipeline.checkGroup(group.group.id, {
                  forceRefresh: false,
                  groupAdmission: options.groupAdmission,
                  signal,
                  scheduledMonitor,
                  authorize: async () => undefined,
                  checkpoint,
                })
              : await options.competitorPipeline.checkGroup(group.group.id, {
                  forceRefresh: false,
                  groupAdmission: options.groupAdmission,
                  signal,
                  scheduledMonitor,
                  authorize: async () => undefined,
                  checkpoint,
                });
          const counts = resultCounts(result);
          brokenGroups += counts.brokenGroups;
          brokenMembers += counts.brokenMembers;
        } catch (error) {
          // A lost COMMIT acknowledgement is reconciled by the immutable receipt.
          // If no receipt exists, leave the run running and let BullMQ retry.
          try {
            const committed = await ledger.readGroupReceipt(
              job,
              group.ordinal,
              signal,
            );
            if (committed !== undefined) {
              const counts = resultCounts(committed);
              brokenGroups += counts.brokenGroups;
              brokenMembers += counts.brokenMembers;
              continue;
            }
          } catch (reconciliationError) {
            if (reconciliationError instanceof ScheduledMonitorRunError)
              throw reconciliationError;
            throw error;
          }
          if (isCancellation(error)) throw error;
          throw error;
        }
      }
      const completed = await ledger.completeBusiness(
        job,
        {
          version: 1,
          totalGroups: run.groups.length,
          totalMembers: run.totalMembers,
          brokenGroups,
          brokenMembers,
        },
        job.domain === 'primary' && job.country === 'US',
        signal,
      );
      activeRun = completed;
      if (options.deliverNotifications)
        await options.deliverNotifications(completed, signal, checkpoint);
      if (completed.followUpJob)
        await options.enqueueFollowUp(completed.followUpJob);
      return ledger.complete(job, signal);
    } catch (error) {
      const reason = signal.reason;
      const observed = isCancellation(error) || isCancellation(reason);
      const shuttingDown = options.shutdownSignal.aborted;
      if (observed && !shuttingDown) {
        const current = await ledger.read(job).catch(() => undefined);
        if (current?.cancelRequestedAt)
          return ledger.finishWithoutBusiness(job, 'cancelled');
        if (current?.state === 'skipped-expired') return current;
      }
      if (
        (error instanceof ScheduledMonitorRunError &&
          error.code === 'expired') ||
        (reason instanceof ScheduledMonitorRunError &&
          reason.code === 'expired')
      ) {
        return ledger.finishWithoutBusiness(job, 'skipped-expired');
      }
      const finalAttempt =
        bullJob.attemptsMade + 1 >= (bullJob.opts.attempts ?? 1);
      const uncertain = commitMayHaveSucceeded(error);
      const permanent =
        error instanceof ScheduledMonitorRunError &&
        ['input', 'identity', 'snapshot', 'state'].includes(error.code);
      if (finalAttempt && !uncertain && !permanent && !signal.aborted) {
        const current = await ledger.read(job, signal).catch(() => undefined);
        if (
          current &&
          !['completed', 'cancelled', 'skipped-expired'].includes(current.state)
        )
          return ledger.finishWithoutBusiness(job, 'failed', signal);
      }
      if (permanent) throw new UnrecoverableError('定时监控任务账本身份无效');
      logger.warn('定时监控任务等待恢复或对账', {
        reason: uncertain
          ? 'scheduled_monitor_commit_unconfirmed'
          : 'scheduled_monitor_attempt_interrupted',
      });
      throw error;
    } finally {
      heartbeatStopped = true;
      if (heartbeat) clearTimeout(heartbeat);
      await heartbeatCheck;
      options.shutdownSignal.removeEventListener('abort', onShutdown);
    }
  };
}
