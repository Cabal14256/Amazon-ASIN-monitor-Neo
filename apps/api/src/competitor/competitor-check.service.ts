import type { Env } from '@asin-monitor/config';
import { variantCheckJobSchema } from '@asin-monitor/contracts';
import {
  CompetitorTransactionError,
  VariantCheckError,
  type CompetitorCheckRepositoryPort,
} from '@asin-monitor/db';
import { SpApiError } from '@asin-monitor/sp-api';
import {
  parseVariantCheckJob,
  VariantCheckCommitUncertainError,
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
import {
  checkRequestObject,
  useAsyncCheck,
} from '../variant-check/variant-check-values';
import { VariantCheckSubmissionError } from '../variant-check/variant-check.service';
import { COMPETITOR_CHECK_REPOSITORY } from './competitor-check-storage.module';
import { ApplicationCompetitorCheckRuntime } from './competitor-check.runtime';

type CheckType = 'competitor-asin-check' | 'competitor-variant-group-check';
function fail(status: number, message: string): never {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage: message },
    status,
  );
}
@Injectable()
export class CompetitorCheckService implements OnModuleDestroy {
  private readonly active = new Set<AbortController>();
  private closed = false;
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(COMPETITOR_CHECK_REPOSITORY)
    private readonly repository: CompetitorCheckRepositoryPort,
    @Inject(ApplicationCompetitorCheckRuntime)
    private readonly runtime: ApplicationCompetitorCheckRuntime,
    @Inject(TaskQueryRuntime) private readonly tasks: TaskQueryRuntime,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  async execute(
    type: CheckType,
    id: string,
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<unknown> {
    if (
      request.headers.origin &&
      request.headers.origin !== this.env.CORS_ORIGIN
    )
      fail(403, '不允许的请求来源');
    if (this.env.AUTH_DATA_AUTHORITY !== 'postgresql')
      fail(503, '鉴权权威源尚未切换，请使用现有检查入口');
    if (this.closed) fail(503, '竞品检查服务正在停止');
    if (this.active.size >= 4) fail(429, '竞品检查繁忙，请稍后再试');
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
    let submission: string | undefined;
    let finished = false;
    try {
      const body = checkRequestObject(request.body);
      const query = checkRequestObject(request.query);
      const parsed =
        type === 'competitor-asin-check'
          ? variantCheckJobSchema.options[2].shape.params.safeParse({
              asinId: id,
              forceRefresh:
                query.forceRefresh !== 'false' && body.forceRefresh !== false,
            })
          : variantCheckJobSchema.options[3].shape.params.safeParse({
              groupId: id,
              forceRefresh:
                query.forceRefresh !== 'false' && body.forceRefresh !== false,
            });
      if (!parsed.success) throw new VariantCheckError('invalid-input');
      const params = parsed.data;
      const principal = request.auth!;
      const scope = {
        forceRefresh: params.forceRefresh,
        signal: controller.signal,
        checkpoint: async () => {
          controller.signal.throwIfAborted();
          if (finished) throw new Error('COMPETITOR_CHECK_REQUEST_FINISHED');
        },
        authorize: async (
          unit: Parameters<typeof authorizeAdministration>[0],
        ) => {
          await authorizeAdministration(unit, principal, 'asin:read');
          controller.signal.throwIfAborted();
        },
      };
      await this.repository.transaction(async (unit) => {
        await scope.authorize(unit);
        if (type === 'competitor-asin-check') await unit.loadSingle(id);
        else await unit.loadGroup(id);
      }, controller.signal);
      // The active Legacy caller expects a completed result when this flag is absent.
      if (useAsyncCheck(body, query, false)) {
        const deadline = performance.now() + 3000;
        const port = this.tasks.openCheck(() => {
          controller.signal.throwIfAborted();
          if (finished || performance.now() >= deadline)
            throw new Error('COMPETITOR_CHECK_SUBMISSION_DEADLINE');
        });
        submission = randomUUID();
        const task = await port.store.create({
          taskId: submission,
          userId: principal.userId,
          taskType: 'variant-check',
          taskSubType: type,
          title:
            type === 'competitor-asin-check'
              ? '竞品 ASIN 检查'
              : '竞品变体组检查',
          message: '竞品检查任务已创建，等待处理',
        });
        const raw =
          type === 'competitor-asin-check'
            ? {
                taskType: 'variant-check' as const,
                taskSubType: type,
                params: params as { asinId: string; forceRefresh: boolean },
              }
            : {
                taskType: 'variant-check' as const,
                taskSubType: type,
                params: params as { groupId: string; forceRefresh: boolean },
              };
        await port.enqueue(
          parseVariantCheckJob({
            ...raw,
            taskId: task.taskId,
            userId: task.userId,
            createdAt: task.createdAt,
            expiresAt: new Date(
              Date.parse(task.createdAt) +
                this.env.TASK_META_TTL_SECONDS * 1000,
            ).toISOString(),
          }),
        );
        this.logger.info('竞品检查任务已创建', 'CompetitorCheckService', {
          taskType: type,
        });
        return { taskId: task.taskId, status: 'pending', taskType: type };
      }
      const input = {
        ...scope,
        forceRefresh: params.forceRefresh,
      };
      return await (type === 'competitor-asin-check'
        ? this.runtime.pipeline.checkSingle(id, input)
        : this.runtime.pipeline.checkGroup(id, input));
    } catch (error) {
      if (submission) {
        this.logger.warn(
          '竞品检查任务提交结果未确认',
          'CompetitorCheckService',
          { reason: 'competitor_check_enqueue_unconfirmed' },
        );
        throw new VariantCheckSubmissionError(submission);
      }
      if (error instanceof HttpException) throw error;
      if (error instanceof VariantCheckError)
        fail(
          error.code === 'invalid-input'
            ? 400
            : error.code === 'group-not-found' ||
              error.code === 'asin-not-found'
            ? 404
            : error.code === 'snapshot-changed'
            ? 409
            : error.code === 'capacity'
            ? 429
            : 500,
          error.message,
        );
      if (error instanceof CompetitorTransactionError)
        fail(
          error.code === 'capacity' ? 429 : 503,
          error.code === 'commit-uncertain'
            ? '检查写入结果需要核实，请查看竞品检查历史'
            : '竞品检查暂不可用，请稍后重试',
        );
      if (error instanceof VariantCheckCommitUncertainError)
        fail(503, error.message);
      if (controller.signal.aborted)
        fail(408, '检查已中断或超时，请核实竞品检查历史');
      if (error instanceof SpApiError)
        fail(
          error.code === 'CAPACITY' ? 429 : 503,
          '竞品检查上游暂不可用，请稍后重试',
        );
      this.logger.error('竞品检查失败', 'CompetitorCheckService', {
        reason: 'competitor_check_failed',
      });
      fail(500, '竞品检查失败');
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
