import type { Env } from '@asin-monitor/config';
import { triggerCompetitorMonitorAsyncRequestSchema } from '@asin-monitor/contracts';
import {
  competitorMonitorEnabled,
  type SpApiConfigurationRepositoryPort,
} from '@asin-monitor/db';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { authorizeAdministration } from '../auth/administration-authorization';
import type { AuthPrincipal } from '../auth/auth.types';
import {
  ApplicationCatalogOperations,
  type CatalogOperationSubmission,
} from '../catalog/catalog-operation.service';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import { SP_API_CONFIG_REPOSITORY } from '../sp-api-config/sp-api-config.service';
import { TaskQueryRuntime } from '../tasks/task-query.runtime';

const ALL_COUNTRIES = ['US', 'UK', 'DE', 'FR', 'IT', 'ES'] as const;
const fail = (status: number, message: string): never => {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage: message },
    status,
  );
};
export class CompetitorMonitorSubmissionUnconfirmed extends HttpException {
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
/** Fixed public control status, with no database error or request payload. */
export class CompetitorMonitorDisabled extends HttpException {
  constructor() {
    super(
      { success: false, errorCode: 503, errorMessage: '竞品监控已关闭' },
      503,
    );
  }
}

@Injectable()
export class CompetitorMonitorTriggerService {
  private active = 0;
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(SP_API_CONFIG_REPOSITORY)
    private readonly repository: SpApiConfigurationRepositoryPort,
    @Inject(TaskQueryRuntime) private readonly tasks: TaskQueryRuntime,
    @Inject(AppLogger) private readonly logger: AppLogger,
    @Inject(ApplicationCatalogOperations)
    private readonly catalog: ApplicationCatalogOperations,
  ) {}
  async trigger(principal: AuthPrincipal, raw: unknown) {
    if (this.env.AUTH_DATA_AUTHORITY !== 'postgresql')
      fail(503, '鉴权权威源尚未切换，请使用现有监控入口');
    return this.catalog.execute(
      principal,
      'competitor',
      'monitor',
      'monitor:write',
      (submission) => this.triggerReserved(principal, raw, submission),
    );
  }
  private async triggerReserved(
    principal: AuthPrincipal,
    raw: unknown,
    catalog: CatalogOperationSubmission,
  ) {
    const parsed = triggerCompetitorMonitorAsyncRequestSchema.safeParse(
      raw === undefined ? {} : raw,
    );
    if (!parsed.success) fail(400, '监控国家参数无效');
    if (this.active >= 4) fail(429, '监控任务提交繁忙，请稍后再试');
    this.active++;
    let submission: string | undefined;
    let taskCreatedAt: string | undefined;
    let port: ReturnType<TaskQueryRuntime['openCompetitorMonitor']> | undefined;
    const deadline = performance.now() + 3000;
    const ensureOpen = () => {
      if (performance.now() >= deadline)
        throw new Error('MONITOR_SUBMISSION_DEADLINE');
    };
    try {
      const countries = parsed.data!.countries ?? [...ALL_COUNTRIES];
      port = this.tasks.openCompetitorMonitor(ensureOpen);
      await this.repository.transaction(async (unit) => {
        await authorizeAdministration(unit, principal, 'monitor:write');
        const config = await unit.findConfiguration(
          'COMPETITOR_MONITOR_ENABLED',
        );
        if (
          !competitorMonitorEnabled(
            config?.configValue,
            this.env.COMPETITOR_MONITOR_ENABLED,
          )
        )
          throw new CompetitorMonitorDisabled();
      });
      await port.assertConsumer();
      ensureOpen();
      submission = randomUUID();
      catalog.retain();
      const task = await port.store.create(
        {
          taskId: submission,
          userId: principal.userId,
          taskType: 'competitor-monitor',
          taskSubType: 'competitor',
          title: '竞品 ASIN 监控',
          message: '监控任务已创建，等待处理',
        },
        (prepared) => catalog.bindTask(prepared),
      );
      taskCreatedAt = task.createdAt;
      await port.enqueue({
        taskId: task.taskId,
        taskType: 'competitor-monitor',
        taskSubType: 'competitor',
        userId: task.userId,
        createdAt: task.createdAt,
        expiresAt: new Date(
          Date.parse(task.createdAt) + this.env.TASK_META_TTL_SECONDS * 1000,
        ).toISOString(),
        countries,
      });
      this.logger.info(
        '竞品监控任务已入队',
        'CompetitorMonitorTriggerService',
        {
          countryCount: countries.length,
        },
      );
      return {
        message: '监控任务已加入队列',
        queued: true,
        jobId: task.taskId,
        countries,
      };
    } catch (error) {
      const knownRejection =
        error instanceof Error &&
        [
          'MONITOR_CONSUMER_NOT_READY',
          'MONITOR_QUEUE_FULL',
          'MONITOR_ADMISSION_BUSY',
          'MONITOR_ADMISSION_LOST',
        ].includes(error.message);
      if (knownRejection && submission && taskCreatedAt && port) {
        try {
          const failed = await port.store.mutate(
            submission,
            { kind: 'failed', message: '监控任务未入队，请重新提交' },
            {
              userId: principal.userId,
              taskType: 'competitor-monitor',
              taskSubType: 'competitor',
              createdAt: taskCreatedAt,
            },
          );
          if (!failed || failed.status !== 'failed')
            throw new Error('MONITOR_REJECTION_STATE_UNCONFIRMED');
          if (!(await catalog.reject()))
            throw new Error('MONITOR_REJECTION_FENCE_UNCONFIRMED');
        } catch {
          this.logger.warn(
            '监控任务拒绝状态写入未确认',
            'CompetitorMonitorTriggerService',
            {
              reason: 'monitor_rejection_state_unconfirmed',
            },
          );
          throw new CompetitorMonitorSubmissionUnconfirmed(submission);
        }
      }
      if (knownRejection) {
        if (error.message === 'MONITOR_CONSUMER_NOT_READY')
          fail(503, '监控消费者尚未就绪');
        if (error.message === 'MONITOR_ADMISSION_LOST')
          fail(503, '监控队列暂不可用，请稍后再试');
        fail(
          429,
          error.message === 'MONITOR_ADMISSION_BUSY'
            ? '监控任务提交繁忙，请稍后再试'
            : '监控队列已满，请稍后再试',
        );
      }
      if (submission) {
        this.logger.warn(
          '监控任务提交结果未确认',
          'CompetitorMonitorTriggerService',
          {
            reason: 'monitor_enqueue_unconfirmed',
          },
        );
        throw new CompetitorMonitorSubmissionUnconfirmed(submission);
      }
      if (error instanceof HttpException) throw error;
      this.logger.error('监控任务提交失败', 'CompetitorMonitorTriggerService', {
        reason: 'monitor_submission_failed',
      });
      fail(500, '监控任务提交失败');
    } finally {
      this.active--;
    }
  }
}
