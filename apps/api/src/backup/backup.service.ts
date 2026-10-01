import { getBackupStorageDirectory, type Env } from '@asin-monitor/config';
import {
  BACKUP_SCHEDULER_USER_ID,
  backupJobDataSchema,
  createBackupRequestSchema,
  restoreBackupRequestSchema,
  saveBackupConfigRequestSchema,
  type BackupJobData,
  type BackupTarget,
} from '@asin-monitor/contracts';
import {
  BackupConfigError,
  backupConfigView,
  type BackupConfigRepositoryPort,
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
import { serializeTask } from '../tasks/task-query-values';
import { TaskQueryRuntime } from '../tasks/task-query.runtime';
import {
  backupFilenameTarget,
  deleteBackupFile,
  inspectBackupFile,
  listBackupFiles,
  readBackupMetadata,
  resolveBackupPath,
} from './backup-files';

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
  return typeof code === 'string' && /^E[A-Z0-9_]{1,32}$/.test(code)
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

  private authorize(principal: AuthPrincipal) {
    return this.configs.transaction(async (unit) => {
      await authorizeAdministration(unit, principal, 'settings:write');
    });
  }

  private async capability(target: BackupTarget) {
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
    return {
      hasTimescale: result.rows.length === 1,
      extensionVersion: result.rows[0]?.extversion as string | undefined,
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

  private async enqueue(
    principal: AuthPrincipal,
    data: Omit<BackupJobData, 'taskId' | 'createdAt' | 'userId'>,
  ) {
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
      throw new HttpException(
        {
          success: false,
          errorCode: 500,
          errorMessage: '任务提交结果未确认，请查询此任务状态后再操作',
          data: { taskId, status: 'unknown' },
        },
        500,
      );
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
      const task = await this.enqueue(principal, {
        taskType: 'backup',
        taskSubType: 'create',
        operation: 'create',
        target,
        params: {
          tables: input.tables,
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
      } catch {
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
      const capability = await this.capability(target);
      const timescaleTarget = capability.hasTimescale;
      if ((metadata.sourceEngine === 'timescaledb') !== timescaleTarget)
        return fail(409, '备份文件来源数据库类型与恢复目标不一致');
      if (
        metadata.version === 4 &&
        metadata.sourceEngine === 'timescaledb' &&
        metadata.timescale.extensionVersion !== capability.extensionVersion
      )
        return fail(409, 'TimescaleDB 扩展版本与备份不一致');
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
        this.capability('primary'),
        this.capability('competitor'),
      ]);
      if (
        primaryTimescale.status === 'rejected' ||
        competitorTimescale.status === 'rejected'
      )
        this.logger.warn('备份恢复能力未确认', 'BackupService', {
          reason: 'backup_restore_capability_unconfirmed',
        });
      return files.map((file) => {
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
            file.sourceExtensionVersion === capability.value.extensionVersion);
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
      const port = this.tasks.open(() => {
        if (performance.now() >= deadline)
          throw new Error('BACKUP_SCHEDULE_QUERY_DEADLINE');
      });
      const tasks = await port.store.listUser(BACKUP_SCHEDULER_USER_ID, {
        limit: 50,
      });
      return tasks
        .filter(
          (task) =>
            task.userId === BACKUP_SCHEDULER_USER_ID &&
            task.taskType === 'backup' &&
            task.taskSubType === 'create',
        )
        .map((task) => ({
          ...serializeTask(task),
          canCancel: false,
          downloadUrl: null,
        }));
    });
  }

  async download(principal: AuthPrincipal, filename: string) {
    return this.run('download', async () => {
      await this.authorize(principal);
      const path = resolveBackupPath(this.directory(), filename);
      try {
        await inspectBackupFile(path);
      } catch {
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
