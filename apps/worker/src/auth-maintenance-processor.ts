import type { Env } from '@asin-monitor/config';
import type { AuthMaintenanceRepositoryPort } from '@asin-monitor/db';
import { UnrecoverableError, type Processor, type Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import {
  AUTH_MAINTENANCE_JOB_OPTIONS,
  type AuthMaintenanceJobName,
} from './auth-maintenance-schedules';
import { logger } from './logger';

export interface AuthMaintenanceResult {
  operation: AuthMaintenanceJobName;
  processed: number;
  continued: boolean;
}
class MaintenanceBusyError extends Error {}

export function createAuthMaintenanceProcessor(
  env: Pick<Env, 'AUTH_DATA_AUTHORITY'>,
  repository: AuthMaintenanceRepositoryPort,
  queue: Pick<Queue, 'add'>,
  log: Pick<typeof logger, 'info' | 'warn' | 'error'> = logger,
): Processor<unknown, AuthMaintenanceResult, string> {
  return async (job) => {
    const operation = job.name;
    const data = job.data;
    if (
      env.AUTH_DATA_AUTHORITY !== 'postgresql' ||
      !['session-cleanup', 'audit-archive'].includes(operation) ||
      !data ||
      typeof data !== 'object' ||
      Array.isArray(data) ||
      Object.keys(data).length !== 1 ||
      !('schemaVersion' in data) ||
      data.schemaVersion !== 1 ||
      typeof job.id !== 'string' ||
      !job.id ||
      job.id.length > 2000
    ) {
      log.warn('认证维护任务被拒绝', {
        reason: 'invalid_maintenance_job_or_authority',
      });
      throw new UnrecoverableError(
        'Invalid authentication maintenance job or authority',
      );
    }
    let processed = 0;
    const started = Date.now();
    const now = new Date(started);
    log.info('认证维护任务开始', { operation });
    try {
      for (
        let batch = 0;
        batch < 100 && Date.now() - started < 30_000;
        batch++
      ) {
        const result =
          operation === 'session-cleanup'
            ? await repository.cleanupSessions(1000, now)
            : await repository.archiveAuditLogs(90, 1000, now);
        processed += result.processed;
        if (result.busy || (result.hasMore && result.processed === 0))
          throw new MaintenanceBusyError();
        if (!result.hasMore) {
          log.info('认证维护任务完成', { operation, processed });
          return {
            operation: operation as AuthMaintenanceJobName,
            processed,
            continued: false,
          };
        }
      }
      // A stable continuation ID survives a lost Redis acknowledgement. Retrying
      // this job cannot create another next hop; committed DB batches are idempotent.
      const jobId = `auth-maintenance-next-${createHash('sha256')
        .update(job.id)
        .digest('hex')}`;
      await queue.add(
        operation,
        { schemaVersion: 1 },
        { ...AUTH_MAINTENANCE_JOB_OPTIONS, jobId, delay: 1000 },
      );
      log.info('认证维护任务已安排继续处理', { operation, processed });
      return {
        operation: operation as AuthMaintenanceJobName,
        processed,
        continued: true,
      };
    } catch (error) {
      if (error instanceof MaintenanceBusyError) {
        log.warn('认证维护遇到锁竞争，将重试', {
          operation,
          processed,
          reason: 'maintenance_busy',
        });
        throw new Error('Authentication maintenance is busy');
      }
      log.error('认证维护任务失败', {
        operation,
        processed,
        reason: 'maintenance_failed',
      });
      // BullMQ persists error messages/stacks. Never persist the driver's SQL,
      // connection details or audit payload in a failed job.
      throw new Error('Authentication maintenance failed');
    }
  };
}
