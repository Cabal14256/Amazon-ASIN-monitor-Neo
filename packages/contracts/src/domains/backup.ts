import { z } from 'zod';

import { resultSchema } from '../envelope';
import { taskInfoSchema } from './tasks';

/**
 * backup 域契约（含管理员计划任务视图）。
 * 来源：server/src/controllers/backupController.js、
 * services/backupService.js、models/BackupConfig.js 实读（2026-08-24）。
 * 注意：GET /backup/:filename/download 为包含 custom dump 和验证过的元数据的 tar 流（非 JSON）。
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
export const backupSourceEngineSchema = z.enum(['postgresql', 'timescaledb']);
export const backupRestoreModeSchema = z.enum(['in-place', 'isolated']);
export const backupScopeSchema = z.enum(['full', 'selective']);
export const BACKUP_SCHEDULER_USER_ID = 'system:backup-scheduler';

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
    /^backup_[0-9]{8}-[0-9]{6}-(?:[a-f0-9]{8}|[a-f0-9]{32})-(?:primary|competitor)\.dump$/,
    'Neo 仅接受本系统生成的 pg_dump custom 文件',
  );
export type BackupFilename = z.infer<typeof backupFilenameSchema>;

/** The worker's immutable Shanghai timestamp, independent of host timezone. */
export function backupCreationFilename(
  taskId: string,
  createdAt: string,
  target: BackupTarget,
): string {
  const stamp = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  })
    .formatToParts(new Date(createdAt))
    .reduce<Record<string, string>>((out, part) => {
      if (part.type !== 'literal') out[part.type] = part.value;
      return out;
    }, {});
  return `backup_${stamp.year}${stamp.month}${stamp.day}-${stamp.hour}${
    stamp.minute
  }${stamp.second}-${taskId.replaceAll('-', '').toLowerCase()}-${target}.dump`;
}

/** Older Intl h24 filenames encode midnight as 24 on that calendar day. */
export function backupFilenameCreatedAt(filename: string): string | undefined {
  if (!backupFilenameSchema.safeParse(filename).success) return undefined;
  const parts = /^backup_(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(
    filename,
  );
  if (!parts) return undefined;
  const [, year, month, day, rawHour, minute, second] = parts;
  const hour = rawHour === '24' ? '00' : rawHour;
  const local = `${year}-${month}-${day}T${hour}:${minute}:${second}.000`;
  const value = Date.parse(`${local}+08:00`);
  if (
    !Number.isFinite(value) ||
    new Date(value + 8 * 3600_000).toISOString().slice(0, 23) !== local
  )
    return undefined;
  return new Date(value).toISOString();
}

/** Sidecar written atomically with each new dump. Missing metadata is unsafe
 * for automated restore, including artifacts from an older Neo deployment. */
const backupArtifactMetadataV1Schema = z
  .object({
    version: z.literal(1),
    filename: backupFilenameSchema,
    target: backupTargetSchema,
    sourceEngine: backupSourceEngineSchema,
  })
  .strict();
export const backupTimescaleManifestSchema = z
  .object({
    extensionVersion: z.string().min(1).max(128),
    hypertables: z.array(z.string().min(1).max(130)).max(10_000),
    continuousAggregates: z.array(z.string().min(1).max(130)).max(10_000),
  })
  .strict();
export type BackupTimescaleManifest = z.infer<
  typeof backupTimescaleManifestSchema
>;
/** Settings needed to rebuild an isolated database with source text semantics. */
const backupLocaleSettingSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => !/[\x00-\x1f\x7f]/.test(value));
export const backupDatabaseSettingsSchema = z.discriminatedUnion(
  'localeProvider',
  [
    z
      .object({
        encoding: z
          .string()
          .min(1)
          .max(32)
          .regex(/^[A-Z0-9_]+$/),
        lcCollate: backupLocaleSettingSchema,
        lcCtype: backupLocaleSettingSchema,
        timeZone: backupLocaleSettingSchema.optional(),
        localeProvider: z.literal('libc'),
      })
      .strict(),
    z
      .object({
        encoding: z
          .string()
          .min(1)
          .max(32)
          .regex(/^[A-Z0-9_]+$/),
        lcCollate: backupLocaleSettingSchema,
        lcCtype: backupLocaleSettingSchema,
        timeZone: backupLocaleSettingSchema.optional(),
        localeProvider: z.literal('icu'),
        icuLocale: backupLocaleSettingSchema,
        icuRules: z
          .string()
          .min(1)
          .max(64 * 1024)
          .refine((value) => !value.includes('\0'))
          .optional(),
      })
      .strict(),
  ],
);
export type BackupDatabaseSettings = z.infer<
  typeof backupDatabaseSettingsSchema
>;
/** Bounds metadata reads while accommodating the largest valid Timescale manifest. */
export const BACKUP_ARTIFACT_METADATA_MAX_BYTES = 16 * 1024 * 1024;
const backupArchiveSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
/** Actual worker execution bounds; dump start is not an exact MVCC snapshot. */
export const backupExecutionTimesSchema = z
  .object({
    timeSource: z.literal('dump-start'),
    dumpStartedAt: z.string().datetime(),
    dumpCompletedAt: z.string().datetime(),
    publicationStartedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      Date.parse(value.dumpStartedAt) > Date.parse(value.dumpCompletedAt) ||
      Date.parse(value.dumpCompletedAt) > Date.parse(value.publicationStartedAt)
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '备份执行时间顺序无效',
      });
  });
export type BackupExecutionTimes = z.infer<typeof backupExecutionTimesSchema>;
export const backupTimeSourceSchema = z.enum([
  'dump-start',
  'filename',
  'mtime',
  'unavailable',
]);
const backupTableNameSchema = z
  .string()
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?$/);
export const backupArtifactMetadataSchema = z.union([
  backupArtifactMetadataV1Schema,
  z
    .object({
      version: z.literal(2),
      filename: backupFilenameSchema,
      target: backupTargetSchema,
      sourceEngine: z.literal('postgresql'),
      description: z.string().max(500).optional(),
    })
    .strict(),
  z
    .object({
      version: z.literal(2),
      filename: backupFilenameSchema,
      target: backupTargetSchema,
      sourceEngine: z.literal('timescaledb'),
      timescale: backupTimescaleManifestSchema,
      databaseSettings: backupDatabaseSettingsSchema,
      description: z.string().max(500).optional(),
    })
    .strict(),
  z
    .object({
      version: z.literal(4),
      creationIdentity: backupArchiveSha256Schema.optional(),
      execution: backupExecutionTimesSchema.optional(),
      filename: backupFilenameSchema,
      target: backupTargetSchema,
      sourceEngine: z.literal('timescaledb'),
      timescale: backupTimescaleManifestSchema,
      archiveSha256: backupArchiveSha256Schema,
      databaseSettings: backupDatabaseSettingsSchema,
      description: z.string().max(500).optional(),
    })
    .strict(),
  z
    .object({
      version: z.literal(3),
      creationIdentity: backupArchiveSha256Schema.optional(),
      execution: backupExecutionTimesSchema.optional(),
      filename: backupFilenameSchema,
      target: backupTargetSchema,
      sourceEngine: z.literal('postgresql'),
      scope: z.literal('full'),
      archiveSha256: backupArchiveSha256Schema,
      databaseSettings: backupDatabaseSettingsSchema,
      description: z.string().max(500).optional(),
    })
    .strict(),
  z
    .object({
      version: z.literal(3),
      creationIdentity: backupArchiveSha256Schema.optional(),
      execution: backupExecutionTimesSchema.optional(),
      filename: backupFilenameSchema,
      target: backupTargetSchema,
      sourceEngine: z.literal('postgresql'),
      scope: z.literal('selective'),
      tables: z.array(backupTableNameSchema).min(1).max(512),
      archiveSha256: backupArchiveSha256Schema,
      databaseSettings: backupDatabaseSettingsSchema,
      description: z.string().max(500).optional(),
    })
    .strict(),
]);
export type BackupArtifactMetadata = z.infer<
  typeof backupArtifactMetadataSchema
>;

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
    timeSource: backupTimeSourceSchema.optional(),
    execution: backupExecutionTimesSchema.optional(),
    // False until the API verifies that the target is plain PostgreSQL.
    restoreSupported: z.boolean().default(false),
    restoreMode: backupRestoreModeSchema.optional(),
    sourceEngine: backupSourceEngineSchema.optional(),
    metadataVersion: z
      .union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)])
      .optional(),
    scope: backupScopeSchema.optional(),
    sourceExtensionVersion: z.string().optional(),
    description: z.string().max(500).optional(),
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
  tables: z.array(backupTableNameSchema).max(512).optional(),
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
    timeSource: backupTimeSourceSchema.optional(),
    execution: backupExecutionTimesSchema.optional(),
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

/** Private queue/registry proof emitted only after complete durable publication
 * validation. The API must remove backupCreationCommit from public results. */
export const backupCreationReceiptSchema = z
  .object({
    operation: z.literal('create'),
    filename: backupFilenameSchema,
    format: backupArtifactFormatSchema,
    target: backupTargetSchema,
    size: z.number().int().min(5),
    createdAt: z.string().datetime(),
    sourceEngine: backupSourceEngineSchema,
    timeSource: z.enum(['dump-start', 'filename']).optional(),
    execution: backupExecutionTimesSchema.optional(),
    restoreSupported: z.literal(true),
    description: z.string().max(500).optional(),
    backupCreationCommit: z
      .object({
        version: z.literal(1),
        taskId: z.string().uuid(),
        userId: z.string().min(1).max(200),
        taskCreatedAt: z.string().datetime(),
        creationIdentity: backupArchiveSha256Schema,
        archiveSha256: backupArchiveSha256Schema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      (value.execution &&
        (value.timeSource !== 'dump-start' ||
          value.createdAt !== value.execution.dumpStartedAt)) ||
      (!value.execution && value.timeSource === 'dump-start')
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '备份时间来源与执行凭据不一致',
      });
  });
export type BackupCreationReceipt = z.infer<typeof backupCreationReceiptSchema>;

/** POST /backup、POST /backup/restore：同步结果或异步任务受理 */
export const backupTaskDataSchema = z.object({
  taskId: z.string(),
  status: z.string(),
  restoreMode: backupRestoreModeSchema.optional(),
});
export const createBackupResultSchema = resultSchema(
  z.union([createBackupSyncDataSchema, backupTaskDataSchema]),
);
export const restoreBackupResultSchema = resultSchema(
  z.union([z.object({ message: z.string() }), backupTaskDataSchema]),
);

/** GET /backup data */
export const backupListResultSchema = resultSchema(z.array(backupFileSchema));
/** GET /backup/scheduled-tasks data */
export const backupScheduledTasksResultSchema = resultSchema(
  z.array(taskInfoSchema),
);

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
    restoreSupported: z.boolean().optional(),
    restoreMode: backupRestoreModeSchema.optional(),
    restoredDatabase: z
      .string()
      .regex(/^neo_restore_(?:primary|competitor)_[a-f0-9]{16}$/)
      .optional(),
    targetDatabaseChanged: z.boolean().optional(),
    verification: z.enum(['unconfirmed', 'confirmed']).optional(),
    description: z.string().max(500).optional(),
    sourceEngine: backupSourceEngineSchema.optional(),
    createdAt: z.string().datetime().optional(),
    timeSource: backupTimeSourceSchema.optional(),
    execution: backupExecutionTimesSchema.optional(),
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.restoreMode !== 'isolated') return;
    if (
      value.operation !== 'restore' ||
      !value.restoredDatabase ||
      value.targetDatabaseChanged !== false
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '隔离恢复必须给出恢复数据库并明确在线目标未变更',
      });
  });
export const backupTaskResultSchema = resultSchema(backupTaskResultDataSchema);

/** A committed in-place transaction is a terminal result, even while its
 * post-restore health probe is still pending. */
export const backupInPlaceRestoreResultSchema = z
  .object({
    operation: z.literal('restore'),
    format: backupArtifactFormatSchema,
    filename: backupFilenameSchema,
    target: backupTargetSchema,
    restoreMode: z.literal('in-place'),
    targetDatabaseChanged: z.literal(true),
    verification: z.enum(['unconfirmed', 'confirmed']),
    message: z.string().min(1).max(2000),
  })
  .strict();

/** A retained isolated restore must stay discoverable even after a lost Redis
 * completion acknowledgement. Its database name is bounded, never a URL. */
export const backupIsolatedRestoreResultSchema = z
  .object({
    operation: z.literal('restore'),
    format: backupArtifactFormatSchema,
    filename: backupFilenameSchema,
    target: backupTargetSchema,
    restoreMode: z.literal('isolated'),
    restoredDatabase: z
      .string()
      .regex(/^neo_restore_(?:primary|competitor)_[a-f0-9]{16}$/),
    targetDatabaseChanged: z.literal(false),
    verification: z.enum(['unconfirmed', 'confirmed']),
    message: z.string().min(1).max(2000),
  })
  .strict();
export const backupRestoreReceiptSchema = z.union([
  backupInPlaceRestoreResultSchema,
  backupIsolatedRestoreResultSchema,
]);
export type BackupRestoreReceipt = z.infer<typeof backupRestoreReceiptSchema>;

/** In-place restore keeps the live database locale. Timezone is a separate
 * database setting and does not require matching for selective table restore. */
export function sameBackupDatabaseLocale(
  left: BackupDatabaseSettings,
  right: BackupDatabaseSettings,
): boolean {
  return (
    left.encoding === right.encoding &&
    left.lcCollate === right.lcCollate &&
    left.lcCtype === right.lcCtype &&
    left.localeProvider === right.localeProvider &&
    (left.localeProvider === 'libc' ||
      (right.localeProvider === 'icu' &&
        left.icuLocale === right.icuLocale &&
        left.icuRules === right.icuRules))
  );
}

/**
 * GET /backup/:filename/download：含 dump 与 .meta.json 的 tar 流（非 JSON），
 * 契约仅登记。
 */
export const backupDownloadResultSchema = resultSchema(z.unknown());
