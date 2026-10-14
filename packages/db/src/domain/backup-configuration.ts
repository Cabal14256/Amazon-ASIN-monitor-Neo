import {
  backupScheduleTypeSchema,
  saveBackupConfigRequestSchema,
  type BackupConfig,
} from '@asin-monitor/contracts';

export type BackupScheduleType = BackupConfig['scheduleType'];

export interface BackupConfigRow {
  id: number | null;
  enabled: boolean;
  scheduleType: BackupScheduleType;
  scheduleValue: number | null;
  backupTime: string | null;
  createTime: Date | null;
  updateTime: Date | null;
}

export interface BackupConfigInput {
  enabled: boolean;
  scheduleType: BackupScheduleType;
  scheduleValue: number | null;
  backupTime: string | null;
}

export class BackupConfigError extends Error {
  constructor(readonly reason: 'input' | 'result' | 'capacity' | 'cancelled') {
    super(`Backup configuration ${reason}`);
    this.name = 'BackupConfigError';
  }
}

const DEFAULT_BACKUP_TIME = '02:00';

export function defaultBackupConfig(): BackupConfigRow {
  return {
    id: null,
    enabled: false,
    scheduleType: 'daily',
    scheduleValue: null,
    backupTime: DEFAULT_BACKUP_TIME,
    createTime: null,
    updateTime: null,
  };
}

function invalidInput(): never {
  throw new BackupConfigError('input');
}

function invalidResult(): never {
  throw new BackupConfigError('result');
}

function isValidTime(value: string): boolean {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function isValidScheduleValue(
  scheduleType: BackupScheduleType,
  value: number | null,
): boolean {
  if (scheduleType === 'daily') return value === null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return false;
  return scheduleType === 'weekly'
    ? value >= 1 && value <= 7
    : value >= 1 && value <= 31;
}

function validateParts(
  value: Pick<
    BackupConfigRow,
    'enabled' | 'scheduleType' | 'scheduleValue' | 'backupTime'
  >,
  reason: 'input' | 'result',
): void {
  if (
    typeof value.enabled !== 'boolean' ||
    !backupScheduleTypeSchema.safeParse(value.scheduleType).success ||
    !isValidScheduleValue(value.scheduleType, value.scheduleValue) ||
    (value.backupTime !== null &&
      (typeof value.backupTime !== 'string' || !isValidTime(value.backupTime)))
  )
    throw new BackupConfigError(reason);
}

/** Parse a write request and fill the same defaults as Legacy BackupConfig. */
export function backupConfigInput(raw: unknown): BackupConfigInput {
  const parsed = saveBackupConfigRequestSchema.safeParse(raw);
  if (!parsed.success) return invalidInput();

  const scheduleType = parsed.data.scheduleType ?? 'daily';
  const input: BackupConfigInput = {
    enabled: parsed.data.enabled === true || parsed.data.enabled === 1,
    scheduleType,
    scheduleValue:
      scheduleType === 'daily' ? null : parsed.data.scheduleValue ?? null,
    backupTime:
      parsed.data.backupTime === undefined
        ? DEFAULT_BACKUP_TIME
        : parsed.data.backupTime,
  };
  validateParts(input, 'input');
  return input;
}

/** Validate a row before it crosses the database boundary. */
export function validateBackupConfigRow(raw: unknown): BackupConfigRow {
  if (!raw || typeof raw !== 'object') return invalidResult();
  const value = raw as Partial<BackupConfigRow>;
  if (value.id === undefined) return invalidResult();
  if (value.id !== null && (!Number.isSafeInteger(value.id) || value.id < 1))
    return invalidResult();
  if (
    [value.createTime, value.updateTime].some(
      (date) =>
        date !== null &&
        date !== undefined &&
        (!(date instanceof Date) || !Number.isFinite(date.getTime())),
    )
  )
    return invalidResult();
  if (
    value.createTime === undefined ||
    value.updateTime === undefined ||
    typeof value.enabled !== 'boolean' ||
    typeof value.scheduleType !== 'string' ||
    value.scheduleValue === undefined ||
    (value.scheduleValue !== null && typeof value.scheduleValue !== 'number') ||
    (value.backupTime !== null && typeof value.backupTime !== 'string')
  )
    return invalidResult();
  validateParts(
    value as Pick<
      BackupConfigRow,
      'enabled' | 'scheduleType' | 'scheduleValue' | 'backupTime'
    >,
    'result',
  );
  return {
    id: value.id ?? null,
    enabled: value.enabled,
    scheduleType: value.scheduleType,
    scheduleValue: value.scheduleValue ?? null,
    backupTime: value.backupTime ?? null,
    createTime: value.createTime ?? null,
    updateTime: value.updateTime ?? null,
  };
}

/** Return the JSON-safe contract shape used by the API and worker readers. */
export function backupConfigView(row: BackupConfigRow | null): BackupConfig {
  const value =
    row === null ? defaultBackupConfig() : validateBackupConfigRow(row);
  return {
    id: value.id,
    enabled: value.enabled,
    scheduleType: value.scheduleType,
    scheduleValue: value.scheduleValue,
    backupTime: value.backupTime,
    createTime: value.createTime?.toISOString() ?? null,
    updateTime: value.updateTime?.toISOString() ?? null,
  };
}
