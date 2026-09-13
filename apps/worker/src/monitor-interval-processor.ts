import type { Env } from '@asin-monitor/config';
import type { MonitorIntervalMaintenanceRepositoryPort } from '@asin-monitor/db';
import { UnrecoverableError, type Processor, type Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import { logger } from './logger';
import {
  MONITOR_INTERVAL_JOB,
  MONITOR_INTERVAL_JOB_OPTIONS,
} from './monitor-interval-schedules';

export interface MonitorIntervalJobResult {
  processed: number;
  deferred: number;
  continued: boolean;
}
export function createMonitorIntervalProcessor(
  env: Pick<Env, 'AUTH_DATA_AUTHORITY' | 'ANALYTICS_STATUS_INTERVAL_ENABLED'>,
  repository: MonitorIntervalMaintenanceRepositoryPort,
  queue: Pick<Queue, 'add'>,
  stopping: () => boolean = () => false,
  log: Pick<typeof logger, 'info' | 'warn' | 'error'> = logger,
): Processor<unknown, MonitorIntervalJobResult, string> {
  return async (job) => {
    const data = job.data;
    if (
      env.AUTH_DATA_AUTHORITY !== 'postgresql' ||
      !env.ANALYTICS_STATUS_INTERVAL_ENABLED ||
      job.name !== MONITOR_INTERVAL_JOB ||
      typeof job.id !== 'string' ||
      !job.id ||
      job.id.length > 2000 ||
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      Object.keys(data).length !== 1 ||
      !('schemaVersion' in data) ||
      data.schemaVersion !== 1
    ) {
      log.warn('状态区间维护任务被拒绝', {
        reason: 'invalid_interval_job_or_authority',
      });
      throw new UnrecoverableError('Invalid monitor interval maintenance job');
    }
    let processed = 0,
      deferred = 0;
    const started = Date.now();
    try {
      for (
        let batch = 0;
        batch < 100 && Date.now() - started < 30_000;
        batch++
      ) {
        if (stopping())
          throw new Error('Monitor interval maintenance is stopping');
        const result = await repository.reconcile();
        if (
          typeof result.processed !== 'boolean' ||
          typeof result.deferred !== 'boolean' ||
          (result.processed && result.deferred)
        )
          throw new Error('Invalid interval maintenance result');
        processed += Number(result.processed);
        deferred += Number(result.deferred);
        if (!result.processed && !result.deferred) {
          if (deferred)
            log.warn('部分状态区间重建延后重试', { processed, deferred });
          else if (processed) log.info('状态区间维护完成', { processed });
          return { processed, deferred, continued: false };
        }
      }
      if (stopping())
        throw new Error('Monitor interval maintenance is stopping');
      const jobId = `monitor-interval-next-${createHash('sha256')
        .update(job.id)
        .digest('hex')}`;
      await queue.add(
        MONITOR_INTERVAL_JOB,
        { schemaVersion: 1 },
        { ...MONITOR_INTERVAL_JOB_OPTIONS, jobId, delay: 1000 },
      );
      if (deferred)
        log.warn('部分状态区间重建延后重试', { processed, deferred });
      log.info('状态区间维护已安排继续处理', { processed, deferred });
      return { processed, deferred, continued: true };
    } catch {
      if (!stopping())
        log.error('状态区间维护失败', {
          processed,
          deferred,
          reason: 'interval_maintenance_failed',
        });
      // BullMQ persists exceptions; never pass driver SQL, connection details or
      // job-provided strings into stored failure messages or logs.
      throw new Error('Monitor interval maintenance failed');
    }
  };
}
