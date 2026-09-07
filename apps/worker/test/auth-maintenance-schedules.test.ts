import { describe, expect, it, vi } from 'vitest';
import {
  AUTH_MAINTENANCE_SCHEDULES,
  installAuthMaintenanceSchedules,
  removeAuthMaintenanceSchedules,
  resolveWorkerSelection,
} from '../src/auth-maintenance-schedules';
import { QUEUE_NAMES } from '../src/queues';

describe('Authentication maintenance schedule selection', () => {
  it.each([undefined, '', ' , ', 'all', '*'])(
    'default/all selects maintenance plus the eight business queues: %s',
    (raw) => {
      expect(resolveWorkerSelection(raw)).toEqual({
        enabledQueues: [...QUEUE_NAMES],
        unknownQueues: [],
        maintenance: true,
      });
    },
  );
  it.each(['none', 'off', 'none,off'])(
    'none/off stays completely idle: %s',
    (raw) => {
      expect(resolveWorkerSelection(raw)).toEqual({
        enabledQueues: [],
        unknownQueues: [],
        maintenance: false,
      });
    },
  );
  it.each(['maintenance', 'AUTH_MAINTENANCE'])(
    'maintenance-only never falls back to all business queues: %s',
    (raw) => {
      expect(resolveWorkerSelection(raw)).toEqual({
        enabledQueues: [],
        unknownQueues: [],
        maintenance: true,
      });
    },
  );
  it('retains aliases, explicit subsets and unknown selector diagnostics', () => {
    expect(
      resolveWorkerSelection('competitor,maintenance,batchCheck,bogus'),
    ).toEqual({
      enabledQueues: ['competitor-monitor', 'batch-check'],
      unknownQueues: ['bogus'],
      maintenance: true,
    });
    expect(resolveWorkerSelection('monitor')).toEqual({
      enabledQueues: ['monitor'],
      unknownQueues: [],
      maintenance: false,
    });
  });
  it('installs only the two stable Beijing cron schedules with bounded retries and retention', async () => {
    const upsertJobScheduler = vi.fn();
    await installAuthMaintenanceSchedules({ upsertJobScheduler });
    expect(upsertJobScheduler.mock.calls).toEqual(
      AUTH_MAINTENANCE_SCHEDULES.map((schedule) => [
        schedule.id,
        { pattern: schedule.pattern, tz: 'Asia/Shanghai' },
        {
          name: schedule.name,
          data: { schemaVersion: 1 },
          opts: {
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: { age: 86400, count: 50 },
            removeOnFail: { age: 604800, count: 200 },
          },
        },
      ]),
    );
  });
  it('removes exactly the two owned schedules during an explicit stop', async () => {
    const removeJobScheduler = vi.fn();
    await removeAuthMaintenanceSchedules({ removeJobScheduler });
    expect(removeJobScheduler.mock.calls).toEqual([
      ['auth-session-cleanup'],
      ['auth-audit-archive'],
    ]);
  });
});
