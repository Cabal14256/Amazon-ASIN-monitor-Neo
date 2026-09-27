import { asinExportArtifactSchema } from '@asin-monitor/contracts';
import { PgAsinQueryRepository } from '@asin-monitor/db';
import { ExportArtifactError } from '@asin-monitor/export';
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
import { authorizeAdministration } from '../auth/administration-authorization';
import { AuthenticationGuard } from '../auth/authentication.guard';
import { ApplicationDatabasePools } from '../database/database.service';
import { ApplicationImportResults } from '../import/import-storage.module';
import { AppLogger } from '../logger/app-logger.service';
import { ApplicationExportArtifacts } from './export-storage.module';
import { TaskQueryService } from './task-query.service';

function fail(status: number, message: string): never {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage: message },
    status,
  );
}
const ASIN_EXPORT_DOWNLOAD_TIMEOUT_MS = 30 * 60_000;

@Injectable()
export class TaskDownloadService implements OnModuleDestroy {
  private readonly active = new Set<AbortController>();
  private closing = false;
  private readonly exportAuthorization: PgAsinQueryRepository;
  constructor(
    @Inject(TaskQueryService) private readonly tasks: TaskQueryService,
    @Inject(ApplicationImportResults)
    private readonly reports: ApplicationImportResults,
    @Inject(ApplicationExportArtifacts)
    private readonly artifacts: ApplicationExportArtifacts,
    @Inject(ApplicationDatabasePools) pools: ApplicationDatabasePools,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {
    this.exportAuthorization = new PgAsinQueryRepository(pools.primaryPool);
  }
  async download(taskId: string, request: FastifyRequest, reply: FastifyReply) {
    if (this.closing) fail(503, '任务下载正在停止');
    if (this.active.size >= 2) fail(429, '任务下载繁忙，请稍后再试');
    const controller = new AbortController();
    this.active.add(controller);
    const abort = () => controller.abort();
    let timer = setTimeout(abort, 120_000);
    timer.unref();
    request.raw.once('aborted', abort);
    reply.raw.once('close', abort);
    try {
      // This also checks current authentication, authority and immutable owner;
      // administrators do not receive access to another user's report.
      const task = await this.tasks.detail(request.auth!, taskId);
      controller.signal.throwIfAborted();
      if (task.status !== 'completed') fail(409, '任务尚未完成，无法下载结果');
      if (
        ['variant-check', 'batch-check'].includes(task.taskType) &&
        task.result !== null &&
        task.filename === `check-result-${task.taskId}.json`
      ) {
        const payload = JSON.stringify(task.result);
        controller.signal.throwIfAborted();
        reply.header('Cache-Control', 'no-store');
        reply.header('Content-Type', 'application/json; charset=utf-8');
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header(
          'Content-Disposition',
          `attachment; filename="check-result-${task.taskId}.json"`,
        );
        reply.header('Content-Length', Buffer.byteLength(payload));
        await reply.send(payload);
        return;
      }
      const result =
        task.result &&
        typeof task.result === 'object' &&
        !Array.isArray(task.result)
          ? (task.result as Record<string, unknown>)
          : {};
      if (task.taskType === 'export' && task.taskSubType === 'asin') {
        const artifact = asinExportArtifactSchema.safeParse(result.artifact);
        if (
          !artifact.success ||
          artifact.data.taskId !== task.taskId ||
          typeof result.filename !== 'string' ||
          !/^ASIN数据_\d{4}-\d{2}-\d{2}\.xlsx$/.test(result.filename)
        )
          fail(404, '任务结果文件不存在或已过期');
        // Task ownership alone does not retain a revoked read grant.
        await this.exportAuthorization.read(async (unit) => {
          await authorizeAdministration(unit, request.auth!, 'asin:read');
        });
        controller.signal.throwIfAborted();
        // The supported 256 MiB XLSX needs time for hashing and slower clients.
        clearTimeout(timer);
        timer = setTimeout(abort, ASIN_EXPORT_DOWNLOAD_TIMEOUT_MS);
        timer.unref();
        const path = await this.artifacts.verifiedPath(
          artifact.data,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        reply.header('Cache-Control', 'no-store');
        reply.header(
          'Content-Type',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        );
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header(
          'Content-Disposition',
          `attachment; filename="asin-export-${
            task.taskId
          }.xlsx"; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
        );
        reply.header('Content-Length', artifact.data.bytes);
        await reply.send(createReadStream(path, { signal: controller.signal }));
        return;
      }
      if (
        task.taskType !== 'import' ||
        !['asin', 'competitor-asin'].includes(task.taskSubType || '') ||
        result.taskSubType !== task.taskSubType ||
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
      if (error instanceof ExportArtifactError)
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
