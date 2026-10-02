/** Queue wait and all attempts share this deadline from immutable createdAt. */
export const BACKUP_TASK_MAX_AGE_MS = 6 * 24 * 60 * 60 * 1000;
/** Leaves a day for bounded command shutdown, cleanup and terminal writes. */
export const BACKUP_TASK_MIN_META_TTL_SECONDS = 7 * 24 * 60 * 60;

export function assertBackupTaskRetention(env: {
  TASK_META_TTL_SECONDS: number;
}): void {
  if (
    !Number.isInteger(env.TASK_META_TTL_SECONDS) ||
    env.TASK_META_TTL_SECONDS < BACKUP_TASK_MIN_META_TTL_SECONDS
  )
    throw new Error('BACKUP_TASK_RETENTION_TOO_SHORT');
}
