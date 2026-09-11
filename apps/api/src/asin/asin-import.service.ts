import type { Env } from '@asin-monitor/config';
import {
  AsinImportRepositoryError,
  AsinTimestampPolicyError,
  type AsinImportRepositoryPort,
} from '@asin-monitor/db';
import {
  ImportParseError,
  importStoredFile,
  type ImportFileReference,
} from '@asin-monitor/import';
import {
  HttpException,
  Inject,
  Injectable,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { authorizeAdministration } from '../auth/administration-authorization';
import type { AuthPrincipal } from '../auth/auth.types';
import { ENV } from '../config/config.module';
import { ApplicationImportStorage } from '../import/import-storage.module';
import { AppLogger } from '../logger/app-logger.service';
import { TaskQueryRuntime } from '../tasks/task-query.runtime';
import { receiveImportFile } from './asin-import-upload';

export const ASIN_IMPORT_REPOSITORY = Symbol('ASIN_IMPORT_REPOSITORY');
export class ImportSubmissionError extends HttpException {
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
function fail(status: number, message: string): never {
  throw new HttpException(
    {
      success: false,
      errorCode: status,
      errorMessage: message,
      data: { successCount: 0, failedCount: 0, errors: [{ message }] },
    },
    status,
  );
}
@Injectable()
export class AsinImportService implements OnModuleDestroy {
  private readonly active = new Set<AbortController>();
  private closed = false;
  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(ASIN_IMPORT_REPOSITORY)
    private readonly repository: AsinImportRepositoryPort,
    @Inject(ApplicationImportStorage)
    private readonly storage: ApplicationImportStorage,
    @Inject(TaskQueryRuntime) private readonly runtime: TaskQueryRuntime,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  async execute(
    principal: AuthPrincipal,
    request: FastifyRequest,
    reply: FastifyReply,
  ) {
    if (this.env.AUTH_DATA_AUTHORITY !== 'postgresql')
      fail(503, '鉴权权威源尚未切换，请使用现有 ASIN 入口');
    if (this.closed) fail(503, 'API 正在停止');
    if (this.active.size >= 2) fail(429, '导入繁忙，请稍后再试');
    const controller = new AbortController();
    this.active.add(controller);
    const timer = setTimeout(() => controller.abort(), 30 * 60 * 1000);
    const abort = () => controller.abort();
    const responseClosed = () => {
      if (!reply.raw.writableEnded) abort();
    };
    request.raw.once('aborted', abort);
    reply.raw.once('close', responseClosed);
    const taskId = randomUUID();
    let file: ImportFileReference | undefined;
    let handedOff = false;
    let submissionStarted = false;
    let requestFinished = false;
    const authorize = () =>
      this.repository.transaction(async (unit) => {
        controller.signal.throwIfAborted();
        await authorizeAdministration(unit, principal, 'asin:write');
        controller.signal.throwIfAborted();
      });
    try {
      await authorize();
      const upload = await receiveImportFile(
        request,
        this.storage,
        taskId,
        AbortSignal.any([controller.signal, AbortSignal.timeout(120_000)]),
      );
      file = upload.file;
      // Permissions/session can change while a slow upload is in progress.
      await authorize();
      if (!upload.useAsync) {
        const result = await importStoredFile(
          file,
          this.storage,
          this.repository,
          { signal: controller.signal },
        );
        this.logger.info('ASIN 导入完成', 'AsinImportService', {
          mode: 'sync',
          successCount: result.successCount,
          failedCount: result.failedCount,
        });
        return result;
      }
      // Authorization committed before any Redis calls. Unknown acknowledgements
      // cannot cause a late enqueue after a rolled-back PG authorization scope.
      const deadline = performance.now() + 3000;
      const port = this.runtime.openImport(() => {
        controller.signal.throwIfAborted();
        if (requestFinished || performance.now() >= deadline)
          throw new Error('IMPORT_ENQUEUE_DEADLINE');
      });
      submissionStarted = true;
      const task = await port.store.create({
        taskId,
        userId: principal.userId,
        taskType: 'import',
        taskSubType: 'asin',
        title: 'ASIN导入',
        message: '导入任务已创建，等待处理',
      });
      await port.enqueue({
        taskId,
        userId: principal.userId,
        createdAt: task.createdAt,
        taskType: 'import',
        taskSubType: 'asin',
        title: 'ASIN导入',
        file,
      });
      handedOff = true;
      this.logger.info('ASIN 导入任务已创建', 'AsinImportService', {
        mode: 'async',
      });
      return { taskId, status: 'pending' as const };
    } catch (error) {
      if (submissionStarted) {
        handedOff = true;
        this.logger.error('ASIN 导入任务提交未确认', 'AsinImportService', {
          reason: 'enqueue_outcome_unknown',
        });
        throw new ImportSubmissionError(taskId);
      }
      if (error instanceof HttpException) throw error;
      if (error instanceof ImportParseError)
        fail(error.code === 'capacity' ? 413 : 400, error.message);
      if (error instanceof AsinTimestampPolicyError)
        fail(503, 'ASIN 写入暂不可用，请使用现有 ASIN 入口');
      if (
        error instanceof AsinImportRepositoryError &&
        error.code === 'capacity'
      )
        fail(429, 'ASIN 写入繁忙，请稍后再试');
      if (
        controller.signal.aborted ||
        (error instanceof Error &&
          ['AbortError', 'TimeoutError'].includes(error.name))
      )
        fail(408, '导入请求已中断或超时');
      this.logger.error('ASIN 导入失败', 'AsinImportService', {
        reason: 'import_failed',
      });
      return fail(500, '导入失败');
    } finally {
      requestFinished = true;
      clearTimeout(timer);
      request.raw.off('aborted', abort);
      reply.raw.off('close', responseClosed);
      if (file && !handedOff)
        await this.storage.remove(file).catch(() =>
          this.logger.warn('导入文件清理失败', 'AsinImportService', {
            reason: 'import_file_cleanup_failed',
          }),
        );
      this.active.delete(controller);
    }
  }
  onModuleDestroy() {
    this.closed = true;
    for (const controller of this.active) controller.abort();
  }
}
