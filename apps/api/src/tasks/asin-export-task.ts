import type { Env } from '@asin-monitor/config';
import {
  asinExportTaskRequestSchema,
  createExportTaskRequestSchema,
} from '@asin-monitor/contracts';
import {
  ASIN_EXPORT_MIN_TASK_TTL_SECONDS,
  PgAsinQueryRepository,
  TaskRegistryError,
} from '@asin-monitor/db';
import {
  Body,
  Controller,
  Header,
  HttpCode,
  HttpException,
  Inject,
  Injectable,
  Post,
  Req,
  UseGuards,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { authorizeAdministration } from '../auth/administration-authorization';
import type { AuthPrincipal } from '../auth/auth.types';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { PermissionsGuard } from '../auth/permissions.guard';
import { RequirePermissions } from '../auth/require-permissions.decorator';
import { ENV } from '../config/config.module';
import { ApplicationDatabasePools } from '../database/database.service';
import { AppLogger } from '../logger/app-logger.service';
import {
  ExportEnqueueRejected,
  TaskQueryRuntime,
  type ExportProducerPort,
} from './task-query.runtime';

function fail(status: number, message: string): never {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage: message },
    status,
  );
}

@Injectable()
export class AsinExportTaskService implements OnModuleDestroy {
  private active = 0;
  private closed = false;
  private readonly authorization: PgAsinQueryRepository;
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(ApplicationDatabasePools) pools: ApplicationDatabasePools,
    @Inject(TaskQueryRuntime) private readonly tasks: TaskQueryRuntime,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {
    this.authorization = new PgAsinQueryRepository(pools.primaryPool);
  }
  async create(principal: AuthPrincipal, raw: unknown) {
    if (this.env.AUTH_DATA_AUTHORITY !== 'postgresql')
      fail(503, '鉴权权威源尚未切换，请使用现有导出入口');
    if (this.env.TASK_META_TTL_SECONDS < ASIN_EXPORT_MIN_TASK_TTL_SECONDS)
      fail(503, '导出任务元数据保留时间不足');
    if (this.closed) fail(503, '导出服务正在停止');
    if (this.active >= 4) fail(429, '导出提交繁忙，请稍后再试');
    const request = createExportTaskRequestSchema.safeParse(raw);
    if (!request.success) fail(400, '导出参数无效');
    if (request.data.exportType !== 'asin')
      fail(501, '此导出类型尚未在 Neo 实现');
    const parsed = asinExportTaskRequestSchema.safeParse(raw);
    if (!parsed.success) fail(400, 'ASIN 导出筛选参数无效');
    this.active++;
    const taskId = randomUUID();
    let submissionStarted = false;
    let taskCreatedAt: string | undefined;
    let port: ExportProducerPort | undefined;
    let closed = false;
    try {
      await this.authorization.read(async (unit) => {
        await authorizeAdministration(unit, principal, 'asin:read');
      });
      const deadline = performance.now() + 3000;
      port = this.tasks.openExport(() => {
        if (closed || performance.now() >= deadline)
          throw new Error('EXPORT_ENQUEUE_DEADLINE');
      });
      submissionStarted = true;
      const task = await port.store.createLimitedExport(
        {
          taskId,
          userId: principal.userId,
          taskType: 'export',
          taskSubType: 'asin',
          title: 'ASIN导出',
          message: '导出任务已创建，等待处理',
        },
        2,
        100,
      );
      taskCreatedAt = task.createdAt;
      await port.enqueue({
        taskId,
        userId: principal.userId,
        createdAt: task.createdAt,
        taskType: 'export',
        taskSubType: 'asin',
        exportType: 'asin',
        params: parsed.data.params,
      });
      this.logger.info('ASIN 导出任务已创建', 'AsinExportTaskService');
      return {
        taskId,
        exportType: 'asin' as const,
        status: 'pending' as const,
      };
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (
        error instanceof TaskRegistryError &&
        error.code === 'TASK_EXPORT_LIMIT'
      )
        fail(429, '已有两个导出任务正在处理，请稍后再试');
      if (
        error instanceof TaskRegistryError &&
        error.code === 'TASK_EXPORT_GLOBAL_LIMIT'
      )
        fail(429, '导出队列已满，请稍后再试');
      if (error instanceof ExportEnqueueRejected && taskCreatedAt && port) {
        try {
          const state = await this.tasks
            .openExport(() => {
              if (this.closed) throw new Error('EXPORT_SERVICE_CLOSED');
            })
            .store.mutate(
              taskId,
              { kind: 'failed', message: 'ASIN 导出未入队，请重试' },
              {
                userId: principal.userId,
                taskType: 'export',
                taskSubType: 'asin',
                createdAt: taskCreatedAt,
              },
            );
          if (state?.status === 'failed')
            fail(503, 'ASIN 导出未入队，请稍后再试');
        } catch (failure) {
          if (failure instanceof HttpException) throw failure;
        }
      }
      if (submissionStarted) {
        this.logger.warn('ASIN 导出任务提交未确认', 'AsinExportTaskService', {
          reason: 'export_enqueue_outcome_unknown',
        });
        return {
          taskId,
          exportType: 'asin' as const,
          status: 'unknown' as const,
        };
      }
      this.logger.error('ASIN 导出提交失败', 'AsinExportTaskService', {
        reason: 'export_create_failed',
      });
      fail(500, '导出提交失败');
    } finally {
      closed = true;
      this.active--;
    }
  }
  onModuleDestroy() {
    this.closed = true;
  }
}

@Controller('tasks')
@UseGuards(AuthenticationGuard, PermissionsGuard)
@RequirePermissions('asin:read')
export class AsinExportTaskController {
  constructor(
    @Inject(AsinExportTaskService)
    private readonly service: AsinExportTaskService,
  ) {}
  @Post('export')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  async create(@Req() request: FastifyRequest, @Body() body: unknown) {
    return {
      success: true,
      errorCode: 0,
      data: await this.service.create(request.auth!, body),
    };
  }
}
