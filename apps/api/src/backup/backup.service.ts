import {
  assertBackupTaskRetention,
  getBackupStorageDirectory,
  type Env,
} from '@asin-monitor/config';
import {
  BACKUP_SCHEDULER_USER_ID,
  backupDatabaseSettingsSchema,
  backupFilenameSchema,
  backupJobDataSchema,
  createBackupRequestSchema,
  restoreBackupRequestSchema,
  sameBackupDatabaseLocale,
  saveBackupConfigRequestSchema,
  type BackupDatabaseSettings,
  type BackupJobData,
  type BackupTarget,
} from '@asin-monitor/contracts';
import {
  BackupConfigError,
  backupConfigView,
  backupSelectiveRestoreQuery,
  BackupTableSelectionError,
  backupTableSelectionQuery,
  isTerminalTaskStatus,
  resolveBackupTableSelection,
  selectiveBackupRestoreBlocked,
  type BackupConfigRepositoryPort,
  type TaskState,
} from '@asin-monitor/db';
import {
  HttpException,
  Inject,
  Injectable,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { QueryConfig } from 'pg';
import { authorizeAdministration } from '../auth/administration-authorization';
import type { AuthPrincipal } from '../auth/auth.types';
import { ENV } from '../config/config.module';
import { ApplicationDatabasePools } from '../database/database.service';
import { AppLogger } from '../logger/app-logger.service';
import { backupCreationResult } from '../tasks/backup-creation-result';
import type { QueueTaskSnapshot } from '../tasks/task-query-values';
import { serializeTask } from '../tasks/task-query-values';
import { TaskQueryRuntime } from '../tasks/task-query.runtime';
import {
  backupFilenameTarget,
  deleteBackupFile,
  inspectBackupFile,
  isUnavailableBackupArtifact,
  listBackupFiles,
  readBackupMetadata,
  resolveBackupPath,
} from './backup-files';
import { BackupSubmissionException } from './backup-submission.exception';

export const BACKUP_CONFIG_REPOSITORY = Symbol('BACKUP_CONFIG_REPOSITORY');

function fail(status: number, message: string): never {
  throw new HttpException(
    { success: false, errorCode: status, errorMessage: message },
    status,
  );
}

function filesystemErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error))
    return undefined;
  const code = error.code;
  return typeof code === 'string' &&
    new Set([
      'ENOENT',
      'EACCES',
      'EPERM',
      'EIO',
      'ESTALE',
      'EROFS',
      'ENOSPC',
      'EBUSY',
      'EMFILE',
      'ENFILE',
      'EISDIR',
    ]).has(code)
    ? code
    : undefined;
}

@Injectable()
export class BackupService implements OnModuleDestroy {
  private active = 0;
  private closed = false;

  constructor(
    @Inject(ENV) private readonly env: Env,
    @Inject(BACKUP_CONFIG_REPOSITORY)
    private readonly configs: BackupConfigRepositoryPort,
    @Inject(TaskQueryRuntime) private readonly tasks: TaskQueryRuntime,
    @Inject(ApplicationDatabasePools)
    private readonly pools: ApplicationDatabasePools,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}

  private directory(): string {
    return getBackupStorageDirectory(this.env);
  }

  private validateFilename(filename: string, operation: 'download' | 'delete') {
    const parsed = backupFilenameSchema.safeParse(filename);
    // Path parameters are exact artifact names; never trim a typo into a
    // different address or log raw caller-controlled input.
    if (!parsed.success || parsed.data !== filename) {
      this.logger.warn('备份文件名无效', 'BackupService', {
        operation,
        reason: 'backup_filename_invalid',
      });
      fail(400, '备份文件名无效');
    }
    return parsed.data;
  }

  private authorize(principal: AuthPrincipal) {
    return this.configs.transaction(async (unit) => {
      await authorizeAdministration(unit, principal, 'settings:write');
    });
  }

  private async capability(target: BackupTarget, includeLocale = false) {
    const pool =
      target === 'primary' ? this.pools.primaryPool : this.pools.competitorPool;
    // The shared pool has a bounded acquisition timeout. Give the catalog
    // query its own deadline so an established stalled session cannot hold a
    // backup API slot or make the list endpoint wait indefinitely.
    const query = {
      text: "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb'",
      query_timeout: 1500,
    } as QueryConfig & { query_timeout: number };
    const result = await pool.query<{ extversion: string }>(query);
    if (
      result.rows.length > 1 ||
      (result.rows.length === 1 &&
        typeof result.rows[0]?.extversion !== 'string')
    )
      throw new Error('BACKUP_CAPABILITY_UNCONFIRMED');
    let databaseSettings: BackupDatabaseSettings | undefined;
    if (includeLocale && result.rows.length === 0) {
      const locale = await pool.query({
        text: 'SELECT pg_encoding_to_char(encoding) AS encoding, datcollate AS "lcCollate", datctype AS "lcCtype", datlocprovider AS "localeProvider", daticulocale AS "icuLocale", daticurules AS "icuRules" FROM pg_database WHERE datname = current_database()',
        query_timeout: 1500,
      } as QueryConfig & { query_timeout: number });
      const row = locale.rows[0];
      if (locale.rows.length !== 1)
        throw new Error('BACKUP_CAPABILITY_UNCONFIRMED');
      databaseSettings = backupDatabaseSettingsSchema.parse(
        row?.localeProvider === 'i'
          ? {
              encoding: row.encoding,
              lcCollate: row.lcCollate,
              lcCtype: row.lcCtype,
              localeProvider: 'icu',
              icuLocale: row.icuLocale,
              ...(row.icuRules ? { icuRules: row.icuRules } : {}),
            }
          : row?.localeProvider === 'c'
          ? {
              encoding: row.encoding,
              lcCollate: row.lcCollate,
              lcCtype: row.lcCtype,
              localeProvider: 'libc',
            }
          : null,
      );
    }
    return {
      hasTimescale: result.rows.length === 1,
      extensionVersion: result.rows[0]?.extversion as string | undefined,
      databaseSettings,
    };
  }

  private async run<T>(
    operation: string,
    action: () => Promise<T>,
  ): Promise<T> {
    if (this.env.AUTH_DATA_AUTHORITY !== 'postgresql')
      fail(503, '鉴权权威源尚未切换，请使用现有备份入口');
    if (this.closed) fail(503, '备份服务正在停止');
    if (this.active >= 8) fail(429, '备份服务繁忙，请稍后再试');
    this.active++;
    try {
      return await action();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof BackupConfigError && error.reason === 'input')
        fail(400, '备份配置参数无效');
      this.logger.error('备份操作失败', 'BackupService', {
        operation,
        reason: 'backup_operation_failed',
        code: filesystemErrorCode(error) ?? 'UNKNOWN',
      });
      fail(500, '备份操作失败');
    } finally {
      this.active--;
    }
  }

  private assertRetention() {
    try {
      assertBackupTaskRetention(this.env);
    } catch {
      this.logger.warn(
        '备份任务元数据保留配置不满足执行窗口',
        'BackupService',
        {
          reason: 'backup_task_retention_too_short',
        },
      );
      fail(503, '备份任务元数据须至少保留七天');
    }
  }

  private async enqueue(
    principal: AuthPrincipal,
    data: Omit<BackupJobData, 'taskId' | 'createdAt' | 'userId'>,
  ) {
    this.assertRetention();
    const taskId = randomUUID();
    const deadline = performance.now() + 3000;
    let closed = false;
    try {
      const port = this.tasks.openBackup(() => {
        if (closed || performance.now() >= deadline)
          throw new Error('BACKUP_ENQUEUE_DEADLINE');
      });
      const task = await port.store.create({
        taskId,
        userId: principal.userId,
        taskType: 'backup',
        taskSubType: data.taskSubType,
        title:
          data.operation === 'create' ? 'PostgreSQL 备份' : 'PostgreSQL 恢复',
        message: '备份任务已创建，等待处理',
      });
      const payload = backupJobDataSchema.parse({
        ...data,
        taskId,
        userId: principal.userId,
        createdAt: task.createdAt,
      });
      await port.enqueue(payload);
      return { taskId, status: 'pending' as const };
    } catch (error) {
      this.logger.error('备份任务提交未确认', 'BackupService', {
        reason: 'backup_enqueue_outcome_unknown',
      });
      throw new BackupSubmissionException(taskId);
    } finally {
      closed = true;
    }
  }

  create(principal: AuthPrincipal, raw: unknown) {
    return this.run('create', async () => {
      const parsed = createBackupRequestSchema.safeParse(raw);
      if (!parsed.success) return fail(400, '备份参数无效');
      const input = parsed.data;
      const target = input.target ?? 'primary';
      if (input.useAsync === false || input.useAsync === 'false')
        return fail(400, 'Neo 备份必须使用异步任务');
      await this.authorize(principal);
      if (input.tables?.length && (await this.capability(target)).hasTimescale)
        return fail(
          409,
          'TimescaleDB 不支持通过 Neo 接口按表备份，请创建完整数据库备份',
        );
      let tables = input.tables;
      if (tables?.length) {
        const pool =
          target === 'primary'
            ? this.pools.primaryPool
            : this.pools.competitorPool;
        try {
          const selection = await pool.query(backupTableSelectionQuery(tables));
          tables = resolveBackupTableSelection(tables, selection.rows);
        } catch (error) {
          if (
            !(error instanceof BackupTableSelectionError) ||
            error.reason !== 'input'
          )
            throw error;
          this.logger.warn('备份表选择无效', 'BackupService', {
            target,
            reason: 'backup_table_selection_invalid',
          });
          return fail(400, '备份表不存在或名称无法安全解析');
        }
      }
      const task = await this.enqueue(principal, {
        taskType: 'backup',
        taskSubType: 'create',
        operation: 'create',
        target,
        params: {
          tables,
          description: input.description,
        },
      });
      this.logger.info('PostgreSQL 备份任务已创建', 'BackupService', {
        target,
      });
      return task;
    });
  }

  restore(principal: AuthPrincipal, raw: unknown) {
    return this.run('restore', async () => {
      const parsed = restoreBackupRequestSchema.safeParse(raw);
      if (!parsed.success) return fail(400, '恢复参数无效');
      const input = parsed.data;
      await this.authorize(principal);
      if (input.useAsync === false || input.useAsync === 'false')
        return fail(400, 'Neo 恢复必须使用异步任务');
      let target: 'primary' | 'competitor';
      try {
        target = input.target ?? backupFilenameTarget(input.filename);
      } catch {
        return fail(400, '只支持 Neo PostgreSQL .dump 备份文件');
      }
      if (backupFilenameTarget(input.filename) !== target)
        return fail(400, '备份文件目标数据库与恢复目标不一致');
      const path = resolveBackupPath(this.directory(), input.filename);
      let fileSize: number;
      try {
        fileSize = (await inspectBackupFile(path)).size;
      } catch (error) {
        if (!isUnavailableBackupArtifact(error)) throw error;
        return fail(404, '备份文件不存在或格式无效');
      }
      if (fileSize > this.env.BACKUP_MAX_BYTES)
        return fail(413, '备份文件超过当前恢复大小限制');
      const metadata = await readBackupMetadata(
        this.directory(),
        input.filename,
      );
      if (
        !metadata ||
        (metadata.sourceEngine === 'timescaledb' && metadata.version !== 4) ||
        (metadata.sourceEngine === 'postgresql' && metadata.version !== 3)
      )
        return fail(409, '备份文件来源或恢复范围元数据未验证，禁止自动恢复');
      const selective =
        metadata.version === 3 && metadata.scope === 'selective';
      const capability = await this.capability(target, selective);
      const timescaleTarget = capability.hasTimescale;
      if ((metadata.sourceEngine === 'timescaledb') !== timescaleTarget)
        return fail(409, '备份文件来源数据库类型与恢复目标不一致');
      if (
        metadata.version === 4 &&
        metadata.sourceEngine === 'timescaledb' &&
        metadata.timescale.extensionVersion !== capability.extensionVersion
      )
        return fail(409, 'TimescaleDB 扩展版本与备份不一致');
      if (
        selective &&
        (!capability.databaseSettings ||
          !sameBackupDatabaseLocale(
            metadata.databaseSettings,
            capability.databaseSettings,
          ))
      )
        return fail(
          409,
          '恢复目标数据库的字符集或排序规则与备份不一致，禁止原位恢复',
        );
      if (metadata.version === 3 && metadata.scope === 'selective') {
        const pool =
          target === 'primary'
            ? this.pools.primaryPool
            : this.pools.competitorPool;
        const dependencies = await pool.query(
          backupSelectiveRestoreQuery(metadata.tables),
        );
        if (selectiveBackupRestoreBlocked(dependencies.rows)) {
          this.logger.warn('按表恢复包含未归档的外部依赖', 'BackupService', {
            target,
            reason: 'backup_selective_restore_dependencies',
          });
          return fail(
            409,
            '所选表有未包含在归档中的外部依赖，请使用完整隔离恢复或创建包含依赖的备份',
          );
        }
      }
      const task = await this.enqueue(principal, {
        taskType: 'backup',
        taskSubType: 'restore',
        operation: 'restore',
        target,
        params: { filename: input.filename },
      });
      this.logger.info('PostgreSQL 恢复任务已创建', 'BackupService', {
        target,
      });
      return {
        ...task,
        restoreMode:
          timescaleTarget ||
          (metadata.version === 3 && metadata.scope === 'full')
            ? ('isolated' as const)
            : ('in-place' as const),
      };
    });
  }

  list(principal: AuthPrincipal) {
    return this.run('list', async () => {
      await this.authorize(principal);
      const files = await listBackupFiles(this.directory());
      const [primaryTimescale, competitorTimescale] = await Promise.allSettled([
        this.capability(
          'primary',
          files.some(
            (file) => file.target === 'primary' && file.scope === 'selective',
          ),
        ),
        this.capability(
          'competitor',
          files.some(
            (file) =>
              file.target === 'competitor' && file.scope === 'selective',
          ),
        ),
      ]);
      if (
        primaryTimescale.status === 'rejected' ||
        competitorTimescale.status === 'rejected'
      )
        this.logger.warn('备份恢复能力未确认', 'BackupService', {
          reason: 'backup_restore_capability_unconfirmed',
        });
      return files.map(({ databaseSettings, ...file }) => {
        const capability =
          file.target === 'primary' ? primaryTimescale : competitorTimescale;
        const validSource =
          (file.sourceEngine === 'postgresql' &&
            file.metadataVersion === 3 &&
            (file.scope === 'full' || file.scope === 'selective')) ||
          (file.sourceEngine === 'timescaledb' && file.metadataVersion === 4);
        const restoreSupported =
          validSource &&
          file.size <= this.env.BACKUP_MAX_BYTES &&
          capability.status === 'fulfilled' &&
          (file.sourceEngine === 'timescaledb') ===
            capability.value.hasTimescale &&
          (file.sourceEngine !== 'timescaledb' ||
            file.sourceExtensionVersion ===
              capability.value.extensionVersion) &&
          (file.scope !== 'selective' ||
            (databaseSettings !== undefined &&
              capability.value.databaseSettings !== undefined &&
              sameBackupDatabaseLocale(
                databaseSettings,
                capability.value.databaseSettings,
              )));
        return {
          ...file,
          restoreSupported,
          restoreMode: restoreSupported
            ? capability.value.hasTimescale || file.scope === 'full'
              ? ('isolated' as const)
              : ('in-place' as const)
            : undefined,
        };
      });
    });
  }

  scheduledTasks(principal: AuthPrincipal) {
    return this.run('scheduled-tasks', async () => {
      await this.authorize(principal);
      const deadline = performance.now() + 3000;
      const ensureOpen = () => {
        if (performance.now() >= deadline)
          throw new Error('BACKUP_SCHEDULE_QUERY_DEADLINE');
      };
      const port = this.tasks.open(ensureOpen);
      const tasks = await port.store.listUser(BACKUP_SCHEDULER_USER_ID, {
        limit: 50,
      });
      const scheduled = tasks.filter(
        (task) =>
          task.userId === BACKUP_SCHEDULER_USER_ID &&
          task.taskType === 'backup' &&
          task.taskSubType === 'create',
      );
      const reconciled: TaskState[] = [];
      for (const task of scheduled) {
        ensureOpen();
        let current = task;
        if (task.status !== 'completed') {
          const queued = await port.findJob(task.taskId, 'backup');
          ensureOpen();
          const verify = (candidate: TaskState | QueueTaskSnapshot | null) => {
            if (
              !candidate ||
              candidate.taskId !== task.taskId ||
              candidate.userId !== task.userId ||
              candidate.taskType !== task.taskType ||
              candidate.taskSubType !== task.taskSubType ||
              candidate.createdAt !== task.createdAt
            )
              throw new Error('BACKUP_SCHEDULE_QUEUE_IDENTITY_MISMATCH');
          };
          if (queued) {
            verify(queued);
            if (queued.status === 'completed' || queued.status === 'failed') {
              const creation =
                queued.status === 'completed'
                  ? backupCreationResult(task, queued)
                  : undefined;
              if (!creation && isTerminalTaskStatus(task.status)) {
                reconciled.push(task);
                continue;
              }
              const recovered = await port.store.mutate(
                task.taskId,
                creation
                  ? {
                      kind: 'backup-create-committed',
                      result: creation,
                      message: '备份完成（已从队列恢复）',
                    }
                  : queued.status === 'completed'
                  ? {
                      kind: 'completed',
                      result: queued.result ?? task.result,
                      message: '备份完成（已从队列恢复）',
                    }
                  : { kind: 'failed', message: '备份任务失败' },
                {
                  userId: task.userId,
                  taskType: task.taskType,
                  taskSubType: task.taskSubType,
                  createdAt: task.createdAt,
                },
              );
              ensureOpen();
              verify(recovered);
              current = recovered!;
            }
          }
        }
        reconciled.push(current);
      }
      return reconciled.map((task) => ({
        ...serializeTask(task),
        canCancel: false,
        downloadUrl: null,
      }));
    });
  }

  async download(principal: AuthPrincipal, filename: string) {
    return this.run('download', async () => {
      await this.authorize(principal);
      this.validateFilename(filename, 'download');
      const path = resolveBackupPath(this.directory(), filename);
      try {
        await inspectBackupFile(path);
      } catch (error) {
        if (!isUnavailableBackupArtifact(error)) throw error;
        fail(404, '备份文件不存在');
      }
      const metadata = await readBackupMetadata(this.directory(), filename);
      if (!metadata) fail(409, '备份元数据未验证，无法下载可恢复归档');
      return { path, filename, metadata };
    });
  }

  remove(principal: AuthPrincipal, filename: string) {
    return this.run('delete', async () => {
      await this.authorize(principal);
      this.validateFilename(filename, 'delete');
      try {
        await deleteBackupFile(this.directory(), filename);
      } catch (error) {
        if (filesystemErrorCode(error) === 'ENOENT')
          fail(404, '备份文件不存在');
        throw error;
      }
      this.logger.info('备份文件已删除', 'BackupService');
      return { message: '删除成功' };
    });
  }

  getConfig(principal: AuthPrincipal) {
    return this.run('get-config', () =>
      this.configs.transaction(async (unit) => {
        await authorizeAdministration(unit, principal, 'settings:write');
        return backupConfigView(await unit.get());
      }),
    );
  }

  saveConfig(principal: AuthPrincipal, raw: unknown) {
    return this.run('save-config', async () => {
      const parsed = saveBackupConfigRequestSchema.safeParse(raw);
      if (!parsed.success) return fail(400, '备份配置参数无效');
      const input = parsed.data;
      const result = await this.configs.transaction(async (unit) => {
        await authorizeAdministration(unit, principal, 'settings:write');
        if (input.enabled === true || input.enabled === 1)
          this.assertRetention();
        return backupConfigView(await unit.upsert(input));
      });
      this.logger.info('备份配置已保存', 'BackupService');
      return result;
    });
  }

  async onModuleDestroy() {
    this.closed = true;
  }
}
