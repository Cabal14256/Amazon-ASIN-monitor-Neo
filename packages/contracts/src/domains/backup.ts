import { z } from 'zod';

import { resultSchema } from '../envelope';

/**
 * backup 域契约（7 端点）。
 * 来源：server/src/controllers/backupController.js、
 * services/backupService.js、models/BackupConfig.js 实读（2026-08-24）。
 * 注意：GET /backup/:filename/download 为 application/sql 文件流（非 JSON）。
 */

// ── 实体 ──

/** 备份列表项（backupService.listBackups 元素） */
export const backupFileSchema = z
  .object({
    filename: z.string(),
    size: z.number(),
    createdAt: z.string(),
  })
  .passthrough();
export type BackupFile = z.infer<typeof backupFileSchema>;

/** 自动备份配置（BackupConfig.findOne/upsert 输出，无记录时返回默认） */
export const backupConfigSchema = z.object({
  id: z.number().nullable(),
  enabled: z.boolean(),
  scheduleType: z.string(),
  scheduleValue: z.string().nullable().optional(),
  backupTime: z.string().nullable().optional(),
});
export type BackupConfig = z.infer<typeof backupConfigSchema>;

// ── 请求 ──

export const createBackupRequestSchema = z.object({
  tables: z.array(z.string()).optional(),
  description: z.string().optional(),
  useAsync: z.union([z.boolean(), z.string()]).optional(),
});
export type CreateBackupRequest = z.infer<typeof createBackupRequestSchema>;

export const restoreBackupRequestSchema = z.object({
  filename: z.string().min(1, '请指定备份文件名'),
  useAsync: z.union([z.boolean(), z.string()]).optional(),
});
export type RestoreBackupRequest = z.infer<typeof restoreBackupRequestSchema>;

export const saveBackupConfigRequestSchema = z.object({
  enabled: z.union([z.boolean(), z.number(), z.string()]).optional(),
  scheduleType: z.string().optional(),
  scheduleValue: z.string().nullable().optional(),
  backupTime: z.string().nullable().optional(),
});
export type SaveBackupConfigRequest = z.infer<
  typeof saveBackupConfigRequestSchema
>;

// ── 响应 data ──

/** POST /backup 同步结果 */
export const createBackupSyncDataSchema = z
  .object({
    filename: z.string(),
    size: z.number().optional(),
    createdAt: z.string().optional(),
  })
  .passthrough();
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

/**
 * GET /backup/:filename/download：application/sql 文件流（非 JSON），
 * 契约仅登记。
 */
export const backupDownloadResultSchema = resultSchema(z.unknown());
