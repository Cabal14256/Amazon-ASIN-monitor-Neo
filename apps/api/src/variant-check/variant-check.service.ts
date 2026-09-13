import type { Env } from '@asin-monitor/config';
import {
  AsinTimestampPolicyError,
  VariantCheckError,
  type VariantCheckRepositoryPort,
} from '@asin-monitor/db';
import { SpApiError } from '@asin-monitor/sp-api';
import {
  parseVariantCheckJob,
  VariantCheckCommitUncertainError,
  type CheckExecutionContext,
} from '@asin-monitor/variant-check';
import {
  HttpException,
  Inject,
  Injectable,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { authorizeAdministration } from '../auth/administration-authorization';
import { ENV } from '../config/config.module';
import { AppLogger } from '../logger/app-logger.service';
import { TaskQueryRuntime } from '../tasks/task-query.runtime';
import { VARIANT_CHECK_REPOSITORY } from './variant-check-storage.module';
import {
  checkRequestObject,
  checkTaskTitle,
  parseCheckRequest,
  useAsyncCheck,
  type CheckSubType,
} from './variant-check-values';
import { ApplicationVariantCheckRuntime } from './variant-check.runtime';

function fail(status: number, message: string): never {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage: message },
    status,
  );
}
/** Only fixed public text and a server-generated lookup ID may bypass the
 * generic 5xx filter, matching existing import/batch-delete handoff behavior. */
export class VariantCheckSubmissionError extends HttpException {
  constructor(taskId: string) {
    super(
      {
        success: false,
        errorCode: 500,
        errorMessage: '任务提交结果未确认，请查询此任务状态后再操作',
        data: { taskId, status: 'unknown' },
      },
      500,
    );
  }
}
@Injectable()
export class VariantCheckService implements OnModuleDestroy {
  private readonly active = new Set<AbortController>();
  private closed = false;
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(VARIANT_CHECK_REPOSITORY)
    private readonly repository: VariantCheckRepositoryPort,
    @Inject(ApplicationVariantCheckRuntime)
    private readonly runtime: ApplicationVariantCheckRuntime,
    @Inject(TaskQueryRuntime) private readonly tasks: TaskQueryRuntime,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  async execute(
    type: CheckSubType,
    request: FastifyRequest,
    reply: FastifyReply,
    id?: string,
  ): Promise<unknown> {
    if (
      request.headers.origin &&
      request.headers.origin !== this.env.CORS_ORIGIN
    )
      fail(403, '不允许的请求来源');
    if (this.env.AUTH_DATA_AUTHORITY !== 'postgresql')
      fail(503, '鉴权权威源尚未切换，请使用现有检查入口');
    if (this.closed) fail(503, '检查服务正在停止');
    if (this.active.size >= 4) fail(429, '检查繁忙，请稍后再试');
    const controller = new AbortController();
    this.active.add(controller);
    const abort = () => controller.abort();
    const close = () => {
      if (!reply.raw.writableEnded) abort();
    };
    request.raw.once('aborted', abort);
    reply.raw.once('close', close);
    const timer = setTimeout(abort, 900_000);
    timer.unref();
    let submission: string | undefined,
      finished = false;
    try {
      const body = checkRequestObject(request.body),
        query = checkRequestObject(request.query);
      const input = parseCheckRequest(type, id, body, query);
      const principal = request.auth;
      if (!principal && ['parent-asin-query', 'variant-group'].includes(type))
        fail(401, '请先登录');
      const asynchronous =
        useAsyncCheck(body, query, !!principal) ||
        (input.taskSubType === 'variant-group' &&
          input.params.groupIds.length > this.env.BATCH_CHECK_SYNC_MAX_GROUPS);
      if (asynchronous && !principal) fail(401, '后台检查需要登录后提交');
      const scope: CheckExecutionContext = {
        signal: controller.signal,
        checkpoint: async () => {
          controller.signal.throwIfAborted();
          if (finished) throw new Error('CHECK_REQUEST_FINISHED');
        },
        authorize: async (unit) => {
          controller.signal.throwIfAborted();
          // These two Legacy routes deliberately retain anonymous sync checks.
          if (principal)
            await authorizeAdministration(unit, principal, 'asin:read');
          controller.signal.throwIfAborted();
        },
      };
      await this.repository.transaction(scope.authorize);
      if (asynchronous) {
        const deadline = performance.now() + 3000;
        const port = this.tasks.openCheck(() => {
          controller.signal.throwIfAborted();
          if (finished || performance.now() >= deadline)
            throw new Error('CHECK_SUBMISSION_DEADLINE');
        });
        submission = randomUUID();
        const task = await port.store.create({
          taskId: submission,
          userId: principal!.userId,
          taskType: input.taskType,
          taskSubType: input.taskSubType,
          title: checkTaskTitle[type],
          message: '检查任务已创建，等待处理',
        });
        await port.enqueue(
          parseVariantCheckJob({
            ...input,
            taskId: task.taskId,
            userId: task.userId,
            createdAt: task.createdAt,
            expiresAt: new Date(
              Date.parse(task.createdAt) +
                this.env.TASK_META_TTL_SECONDS * 1000,
            ).toISOString(),
          }),
        );
        this.logger.info('检查任务已创建', 'VariantCheckService', {
          taskType: input.taskType,
          taskSubType: type,
        });
        return {
          taskId: task.taskId,
          status: 'pending',
          ...(input.taskSubType === 'variant-group'
            ? { total: input.params.groupIds.length }
            : { taskType: type }),
        };
      }
      if (input.taskSubType === 'asin-check')
        return await this.runtime.pipeline.checkSingle(input.params.asinId, {
          ...scope,
          forceRefresh: input.params.forceRefresh,
        });
      if (input.taskSubType === 'variant-group-check')
        return await this.runtime.pipeline.checkGroup(input.params.groupId, {
          ...scope,
          forceRefresh: input.params.forceRefresh,
        });
      if (input.taskSubType === 'variant-group')
        return await this.runtime.executor.checkGroups(
          input.params.groupIds,
          { ...scope, forceRefresh: input.params.forceRefresh },
          this.env.BATCH_CHECK_SYNC_CONCURRENCY,
        );
      const parents = await this.runtime.parents.query(
        input.params.asins,
        input.params.country,
        {
          signal: scope.signal,
          onProgress: async () => {
            await scope.checkpoint();
            await this.repository.transaction(scope.authorize);
          },
        },
      );
      await scope.checkpoint();
      await this.repository.transaction(scope.authorize);
      return parents;
    } catch (error) {
      if (submission) {
        this.logger.warn('检查任务提交结果未确认', 'VariantCheckService', {
          reason: 'variant_check_enqueue_unconfirmed',
        });
        throw new VariantCheckSubmissionError(submission);
      }
      if (error instanceof HttpException) throw error;
      if (error instanceof VariantCheckError)
        fail(
          error.code === 'invalid-input'
            ? 400
            : error.code === 'capacity'
            ? 429
            : 500,
          error.message,
        );
      if (error instanceof AsinTimestampPolicyError)
        fail(503, '检查写入暂不可用，请使用现有检查入口');
      if (error instanceof VariantCheckCommitUncertainError)
        fail(500, error.message);
      if (controller.signal.aborted) fail(408, '检查已中断或超时');
      if (error instanceof SpApiError) {
        if (['CAPACITY', 'BODY_TOO_LARGE'].includes(error.code))
          fail(429, '检查容量已满，请稍后重试');
        if (error.code === 'INVALID_INPUT') fail(400, '检查参数无效');
      }
      this.logger.error('变体检查失败', 'VariantCheckService', {
        reason: 'variant_check_failed',
      });
      fail(500, '变体检查失败');
    } finally {
      finished = true;
      clearTimeout(timer);
      request.raw.off('aborted', abort);
      reply.raw.off('close', close);
      this.active.delete(controller);
    }
  }
  onModuleDestroy() {
    this.closed = true;
    for (const controller of this.active) controller.abort();
  }
}
