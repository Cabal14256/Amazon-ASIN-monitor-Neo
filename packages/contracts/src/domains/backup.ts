import { z } from 'zod';

import { resultSchema } from '../envelope';

/**
 * backup 域契约（7 端点）。
 * 来源：server/src/controllers/backupController.js、
 * services/backupService.js、models/BackupConfig.js 实读（2026-08-24）。
 * 注意：GET /backup/:filename/download 为 pg_dump custom 文件流（非 JSON）。
 * Neo 仅接受 PostgreSQL `pg_dump --format=custom` 产物；Legacy MySQL
 * `.sql` 文件可以保留用于历史审计，但不能通过 Neo 恢复端点导入。
 */

// ── 实体 ──

export const backupScheduleTypeSchema = z.enum(['daily', 'weekly', 'monthly']);
export const backupOperationSchema = z.enum(['create', 'restore']);
export type BackupOperation = z.infer<typeof backupOperationSchema>;
export const backupTargetSchema = z.enum(['primary', 'competitor']);
export type BackupTarget = z.infer<typeof backupTargetSchema>;

/** Stable artifact marker. Do not confuse this with a legacy SQL dump. */
export const BACKUP_ARTIFACT_FORMAT = 'custom' as const;
export const backupArtifactFormatSchema = z.literal(BACKUP_ARTIFACT_FORMAT);
export type BackupArtifactFormat = z.infer<typeof backupArtifactFormatSchema>;

/**
 * Only final artifacts emitted by the Neo worker are addressable. This also
 * excludes in-progress `.partial` files and legacy SQL dumps.
 */
export const backupFilenameSchema = z
  .string()
  .trim()
  .min(1, '请指定备份文件名')
  .max(255, '备份文件名过长')
  .regex(
    /^backup_[0-9]{8}-[0-9]{6}-[a-f0-9]{8}-(?:primary|competitor)\.dump$/,
    'Neo 仅接受本系统生成的 pg_dump custom 文件',
  );
export type BackupFilename = z.infer<typeof backupFilenameSchema>;

const backupTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, 'backupTime 必须为 HH:mm');
const backupScheduleValueSchema = z.number().int().min(1).max(31);

/** 备份列表项（backupService.listBackups 元素） */
export const backupFileSchema = z
  .object({
    filename: backupFilenameSchema,
    format: backupArtifactFormatSchema,
    target: backupTargetSchema,
    size: z.number().int().nonnegative(),
    createdAt: z.string(),
  })
  .passthrough();
export type BackupFile = z.infer<typeof backupFileSchema>;

/** 自动备份配置（BackupConfig.findOne/upsert 输出，无记录时返回默认） */
export const backupConfigSchema = z.object({
  id: z.number().nullable(),
  enabled: z.boolean(),
  scheduleType: backupScheduleTypeSchema,
  scheduleValue: backupScheduleValueSchema.nullable().optional(),
  backupTime: backupTimeSchema.nullable().optional(),
  createTime: z.string().nullable().optional(),
  updateTime: z.string().nullable().optional(),
});
export type BackupConfig = z.infer<typeof backupConfigSchema>;

// ── 请求 ──

export const createBackupRequestSchema = z.object({
  tables: z
    .array(
      z
        .string()
        .max(128)
        .regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/),
    )
    .max(512)
    .optional(),
  description: z.string().max(500).optional(),
  useAsync: z.union([z.boolean(), z.string()]).optional(),
  target: backupTargetSchema.default('primary'),
});
export type CreateBackupRequest = z.infer<typeof createBackupRequestSchema>;

export const restoreBackupRequestSchema = z.object({
  filename: backupFilenameSchema,
  useAsync: z.union([z.boolean(), z.string()]).optional(),
  // Omitted target is inferred from the filename by the API/worker boundary.
  target: backupTargetSchema.optional(),
});
export type RestoreBackupRequest = z.infer<typeof restoreBackupRequestSchema>;

export const saveBackupConfigRequestSchema = z
  .object({
    enabled: z.union([z.boolean(), z.literal(0), z.literal(1)]).optional(),
    scheduleType: backupScheduleTypeSchema.optional(),
    scheduleValue: backupScheduleValueSchema.nullable().optional(),
    backupTime: backupTimeSchema.nullable().optional(),
  })
  .superRefine((value, ctx) => {
    const scheduleType = value.scheduleType ?? 'daily';
    const isEnabled = value.enabled === true || value.enabled === 1;

    if (isEnabled && value.backupTime === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '启用自动备份时 backupTime 不能为空',
        path: ['backupTime'],
      });
    }

    if (scheduleType === 'daily') {
      if (value.scheduleValue !== undefined && value.scheduleValue !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'daily 计划不应设置 scheduleValue',
          path: ['scheduleValue'],
        });
      }
      return;
    }

    if (value.scheduleValue === undefined || value.scheduleValue === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${scheduleType} 计划必须设置 scheduleValue`,
        path: ['scheduleValue'],
      });
      return;
    }

    if (scheduleType === 'weekly' && value.scheduleValue > 7) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'weekly 的 scheduleValue 必须为 1-7',
        path: ['scheduleValue'],
      });
    }
  });
export type SaveBackupConfigRequest = z.infer<
  typeof saveBackupConfigRequestSchema
>;

// ── 响应 data ──

/** POST /backup 同步结果（pg_dump custom artifact） */
export const createBackupSyncDataSchema = z
  .object({
    filename: backupFilenameSchema,
    format: backupArtifactFormatSchema,
    target: backupTargetSchema,
    size: z.number().int().nonnegative().optional(),
    createdAt: z.string().optional(),
  })
  .passthrough();

/**
 * Private BullMQ payload. `files` and `result` are intentionally opaque so a
 * worker can retain bounded references without copying arbitrary database
 * payloads into the queue contract.
 */
const backupJobIdentity = {
  taskId: z.string().uuid(),
  taskType: z.literal('backup'),
  userId: z.string().min(1).max(200),
  createdAt: z.string().datetime(),
  target: backupTargetSchema,
};
const backupCreateJobParamsSchema = z
  .object({
    tables: createBackupRequestSchema.shape.tables,
    description: createBackupRequestSchema.shape.description,
  })
  .strict();
const backupRestoreJobParamsSchema = z
  .object({ filename: backupFilenameSchema })
  .strict();

export const createBackupJobDataSchema = z
  .object({
    ...backupJobIdentity,
    taskSubType: z.literal('create'),
    operation: z.literal('create'),
    params: backupCreateJobParamsSchema,
  })
  .strict();
export const restoreBackupJobDataSchema = z
  .object({
    ...backupJobIdentity,
    taskSubType: z.literal('restore'),
    operation: z.literal('restore'),
    params: backupRestoreJobParamsSchema,
  })
  .strict();
export const backupJobDataSchema = z
  .discriminatedUnion('taskSubType', [
    createBackupJobDataSchema,
    restoreBackupJobDataSchema,
  ])
  .superRefine((value, ctx) => {
    if (
      value.operation === 'restore' &&
      !value.params.filename.endsWith(`-${value.target}.dump`)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '备份文件与恢复目标数据库不一致',
        path: ['params', 'filename'],
      });
  });
export type BackupJobData = z.infer<typeof backupJobDataSchema>;

/** POST /backup、POST /backup/restore：同步结果或异步任务受理 */
export const backupTaskDataSchema = z.object({
  taskId: z.string(),
  status: z.string(),
});
export const createBackupResultSchema = resultSchema(
  z.union([createBackupSyncDataSchema, backupTaskDataSchema]),
);
export const restoreBackupResultSchema = resultSchema(
  z.union([z.object({ message: z.string() }), backupTaskDataSchema]),
);

/** GET /backup data */
export const backupListResultSchema = resultSchema(z.array(backupFileSchema));

/** DELETE /backup/:filename data */
export const deleteBackupResultSchema = resultSchema(
  z.object({ message: z.string() }),
);

/** GET /backup/config、POST /backup/config data */
export const backupConfigResultSchema = resultSchema(backupConfigSchema);

/** Worker result reference retained in task metadata and completion events. */
export const backupTaskResultDataSchema = z
  .object({
    operation: backupOperationSchema,
    target: backupTargetSchema,
    format: backupArtifactFormatSchema,
    filename: backupFilenameSchema.optional(),
    size: z.number().int().nonnegative().optional(),
    files: z.unknown().optional(),
    result: z.unknown().optional(),
    message: z.string().optional(),
  })
  .passthrough();
export const backupTaskResultSchema = resultSchema(backupTaskResultDataSchema);

/**
 * GET /backup/:filename/download：pg_dump custom 文件流（非 JSON），
 * 契约仅登记。
 */
export const backupDownloadResultSchema = resultSchema(z.unknown());
