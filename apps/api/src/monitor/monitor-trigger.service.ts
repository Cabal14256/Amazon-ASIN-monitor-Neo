import type { Env } from '@asin-monitor/config';
import { triggerMonitorRequestSchema } from '@asin-monitor/contracts';
import type { VariantCheckRepositoryPort } from '@asin-monitor/db';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { authorizeAdministration } from '../auth/administration-authorization';
import type { AuthPrincipal } from '../auth/auth.types';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import { TaskQueryRuntime } from '../tasks/task-query.runtime';
import { VARIANT_CHECK_REPOSITORY } from '../variant-check/variant-check-storage.module';

const ALL_COUNTRIES = ['US', 'UK', 'DE', 'FR', 'IT', 'ES'] as const;
const fail = (status: number, message: string): never => {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage: message },
    status,
  );
};
export class MonitorSubmissionUnconfirmed extends HttpException {
  constructor(taskId: string) {
    super(
      {
        success: false,
        errorCode: 500,
        errorMessage: '监控任务提交结果未确认，请查询此任务状态后再操作',
        data: { taskId, status: 'unknown' },
      },
      500,
    );
  }
}

@Injectable()
export class MonitorTriggerService {
  private active = 0;
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(VARIANT_CHECK_REPOSITORY)
    private readonly repository: VariantCheckRepositoryPort,
    @Inject(TaskQueryRuntime) private readonly tasks: TaskQueryRuntime,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  async trigger(principal: AuthPrincipal, raw: unknown) {
    if (this.env.AUTH_DATA_AUTHORITY !== 'postgresql')
      fail(503, '鉴权权威源尚未切换，请使用现有监控入口');
    const parsed = triggerMonitorRequestSchema.safeParse(
      raw === undefined ? {} : raw,
    );
    if (!parsed.success) fail(400, '监控国家参数无效');
    if (this.active >= 4) fail(429, '监控任务提交繁忙，请稍后再试');
    this.active++;
    let submission: string | undefined;
    const deadline = performance.now() + 3000;
    const ensureOpen = () => {
      if (performance.now() >= deadline)
        throw new Error('MONITOR_SUBMISSION_DEADLINE');
    };
    try {
      const countries = parsed.data!.countries ?? [...ALL_COUNTRIES];
      const port = this.tasks.openMonitor(ensureOpen);
      await port.assertConsumer();
      await this.repository.transaction((unit) =>
        authorizeAdministration(unit, principal, 'monitor:write'),
      );
      ensureOpen();
      submission = randomUUID();
      const task = await port.store.create({
        taskId: submission,
        userId: principal.userId,
        taskType: 'monitor',
        taskSubType: 'primary',
        title: '主营 ASIN 监控',
        message: '监控任务已创建，等待处理',
      });
      await port.enqueue({
        taskId: task.taskId,
        taskType: 'monitor',
        taskSubType: 'primary',
        userId: task.userId,
        createdAt: task.createdAt,
        expiresAt: new Date(
          Date.parse(task.createdAt) + this.env.TASK_META_TTL_SECONDS * 1000,
        ).toISOString(),
        countries,
      });
      this.logger.info('主营监控任务已入队', 'MonitorTriggerService', {
        countryCount: countries.length,
      });
      return {
        message: '监控任务已加入队列',
        queued: true,
        jobId: task.taskId,
        countries,
      };
    } catch (error) {
      if (submission) {
        this.logger.warn('监控任务提交结果未确认', 'MonitorTriggerService', {
          reason: 'monitor_enqueue_unconfirmed',
        });
        throw new MonitorSubmissionUnconfirmed(submission);
      }
      if (error instanceof HttpException) throw error;
      if (
        error instanceof Error &&
        error.message === 'MONITOR_CONSUMER_NOT_READY'
      )
        fail(503, '监控消费者尚未就绪');
      if (error instanceof Error && error.message === 'MONITOR_QUEUE_FULL')
        fail(429, '监控队列已满，请稍后再试');
      this.logger.error('监控任务提交失败', 'MonitorTriggerService', {
        reason: 'monitor_submission_failed',
      });
      fail(500, '监控任务提交失败');
    } finally {
      this.active--;
    }
  }
}
