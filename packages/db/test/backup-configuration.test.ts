import { describe, expect, it } from 'vitest';
import {
  BackupConfigError,
  backupConfigInput,
  backupConfigView,
  defaultBackupConfig,
  validateBackupConfigRow,
} from '../src/domain/backup-configuration';

describe('backup configuration domain', () => {
  it('returns the disabled daily default when no row exists', () => {
    expect(backupConfigView(null)).toEqual({
      id: null,
      enabled: false,
      scheduleType: 'daily',
      scheduleValue: null,
      backupTime: '02:00',
      createTime: null,
      updateTime: null,
    });
    expect(defaultBackupConfig()).not.toBe(defaultBackupConfig());
  });

  it.each([
    [
      { enabled: false },
      {
        enabled: false,
        scheduleType: 'daily',
        scheduleValue: null,
        backupTime: '02:00',
      },
    ],
    [
      {
        enabled: 1,
        scheduleType: 'weekly',
        scheduleValue: 7,
        backupTime: '23:59',
      },
      {
        enabled: true,
        scheduleType: 'weekly',
        scheduleValue: 7,
        backupTime: '23:59',
      },
    ],
    [
      {
        enabled: true,
        scheduleType: 'monthly',
        scheduleValue: 31,
        backupTime: '00:00',
      },
      {
        enabled: true,
        scheduleType: 'monthly',
        scheduleValue: 31,
        backupTime: '00:00',
      },
    ],
    [
      {
        enabled: 0,
        scheduleType: 'daily',
        scheduleValue: null,
        backupTime: null,
      },
      {
        enabled: false,
        scheduleType: 'daily',
        scheduleValue: null,
        backupTime: null,
      },
    ],
  ])('normalizes valid input %#', (raw, expected) => {
    expect(backupConfigInput(raw)).toEqual(expected);
  });

  it.each([
    { enabled: true, scheduleType: 'weekly', scheduleValue: 0 },
    { enabled: true, scheduleType: 'weekly', scheduleValue: 8 },
    { enabled: true, scheduleType: 'monthly', scheduleValue: 32 },
    { enabled: false, scheduleType: 'daily', scheduleValue: 1 },
    {
      enabled: true,
      scheduleType: 'daily',
      scheduleValue: null,
      backupTime: '24:00',
    },
    {
      enabled: true,
      scheduleType: 'daily',
      scheduleValue: null,
      backupTime: '2:00',
    },
    {
      enabled: true,
      scheduleType: 'monthly',
      scheduleValue: 1,
      backupTime: null,
    },
    null,
  ])('rejects invalid input %#', (raw) => {
    expect(() => backupConfigInput(raw)).toThrow(BackupConfigError);
  });

  it('validates persisted rows and serializes timestamps', () => {
    const row = validateBackupConfigRow({
      id: 3,
      enabled: true,
      scheduleType: 'weekly',
      scheduleValue: 1,
      backupTime: '08:05',
      createTime: new Date('2026-09-27T00:00:00.000Z'),
      updateTime: new Date('2026-09-27T01:00:00.000Z'),
    });
    expect(backupConfigView(row)).toMatchObject({
      id: 3,
      enabled: true,
      scheduleType: 'weekly',
      scheduleValue: 1,
      backupTime: '08:05',
      createTime: '2026-09-27T00:00:00.000Z',
      updateTime: '2026-09-27T01:00:00.000Z',
    });
  });

  it.each([
    {
      id: 0,
      enabled: false,
      scheduleType: 'daily',
      scheduleValue: null,
      backupTime: '02:00',
    },
    {
      id: 1,
      enabled: false,
      scheduleType: 'daily',
      scheduleValue: 1,
      backupTime: '02:00',
    },
    {
      id: 1,
      enabled: false,
      scheduleType: 'daily',
      scheduleValue: null,
      backupTime: '2:00',
    },
    {
      id: 1,
      enabled: false,
      scheduleType: 'weekly',
      scheduleValue: 8,
      backupTime: '02:00',
    },
  ])('rejects invalid persisted row %#', (row) => {
    expect(() => validateBackupConfigRow(row)).toThrow(BackupConfigError);
  });
});
