import { isImportReportReference } from '@asin-monitor/import';
import {
  Controller,
  Get,
  HttpException,
  Inject,
  Injectable,
  Param,
  Req,
  Res,
  UseGuards,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { ApplicationImportResults } from '../import/import-storage.module';
import { AppLogger } from '../logger/app-logger.service';
import { TaskQueryService } from './task-query.service';

function fail(status: number, message: string): never {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage: message },
    status,
  );
}

@Injectable()
export class TaskDownloadService implements OnModuleDestroy {
  private readonly active = new Set<AbortController>();
  private closing = false;
  constructor(
    @Inject(TaskQueryService) private readonly tasks: TaskQueryService,
    @Inject(ApplicationImportResults)
    private readonly reports: ApplicationImportResults,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  async download(taskId: string, request: FastifyRequest, reply: FastifyReply) {
    if (this.closing) fail(503, '任务下载正在停止');
    if (this.active.size >= 2) fail(429, '任务下载繁忙，请稍后再试');
    const controller = new AbortController();
    this.active.add(controller);
    const abort = () => controller.abort();
    const timer = setTimeout(abort, 120_000);
    timer.unref();
    request.raw.once('aborted', abort);
    reply.raw.once('close', abort);
    try {
      // This also checks current authentication, authority and immutable owner;
      // administrators do not receive access to another user's report.
      const task = await this.tasks.detail(request.auth!, taskId);
      controller.signal.throwIfAborted();
      if (task.status !== 'completed') fail(409, '任务尚未完成，无法下载结果');
      const result =
        task.result &&
        typeof task.result === 'object' &&
        !Array.isArray(task.result)
          ? (task.result as Record<string, unknown>)
          : {};
      if (
        task.taskType !== 'import' ||
        task.taskSubType !== 'asin' ||
        !isImportReportReference(result.report)
      )
        fail(404, '任务结果文件不存在或已过期');
      if (result.report.taskId !== task.taskId)
        fail(404, '任务结果文件不存在或已过期');
      const path = await this.reports.verifiedPath(
        result.report,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      reply.header('Cache-Control', 'no-store');
      reply.header('Content-Type', 'application/json; charset=utf-8');
      reply.header('X-Content-Type-Options', 'nosniff');
      reply.header(
        'Content-Disposition',
        `attachment; filename="import-result-${task.taskId}.json"`,
      );
      reply.header('Content-Length', result.report.bytes);
      // Fastify streams the verified private file with backpressure. Waiting on
      // the reply keeps the capacity slot and deadline until delivery finishes.
      await reply.send(createReadStream(path, { signal: controller.signal }));
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
        fail(404, '任务结果文件不存在或已过期');
      this.logger.error('任务结果下载失败', 'TaskDownloadService', {
        reason: 'task_download_failed',
      });
      if (reply.raw.headersSent) {
        reply.raw.destroy();
        return;
      }
      fail(500, '任务结果下载失败');
    } finally {
      clearTimeout(timer);
      request.raw.off('aborted', abort);
      reply.raw.off('close', abort);
      this.active.delete(controller);
    }
  }
  onModuleDestroy() {
    this.closing = true;
    for (const controller of this.active) controller.abort();
  }
}

@Controller('tasks')
@UseGuards(AuthenticationGuard)
export class TaskDownloadController {
  constructor(
    @Inject(TaskDownloadService) private readonly service: TaskDownloadService,
  ) {}
  @Get(':taskId/download')
  download(
    @Param('taskId') taskId: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ) {
    return this.service.download(taskId, request, reply);
  }
}
