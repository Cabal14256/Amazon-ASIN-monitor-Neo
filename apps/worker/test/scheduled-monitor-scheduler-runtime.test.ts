import type { Env } from '@asin-monitor/config';
import { describe, expect, it, vi } from 'vitest';
import { dispatchScheduledMonitorTick } from '../src/scheduled-monitor-scheduler-runtime';

const env = {
  SCHEDULER_ENABLED: true,
  COMPETITOR_MONITOR_ENABLED: true,
  MONITOR_US_SCHEDULE_MINUTES: 30,
  MONITOR_EU_SCHEDULE_MINUTES: 60,
  MONITOR_BATCH_COUNT: 3,
} as Env;

describe('scheduled monitor tick producer', () => {
  it('reads current DB config and enqueues stable primary/competitor jobs with persisted delays', async () => {
    const competitorEnabled = { value: true };
    const configRepository = {
      readConfiguration: vi.fn(async () => [
        { configKey: 'COMPETITOR_MONITOR_ENABLED', configValue: 'false' },
        { configKey: 'MONITOR_US_SCHEDULE_MINUTES', configValue: '15' },
        { configKey: 'MONITOR_EU_SCHEDULE_MINUTES', configValue: '30' },
      ]),
    };
    const scheduledQueue = { add: vi.fn(async () => ({ id: 'job' })) };
    const count = await dispatchScheduledMonitorTick({
      env,
      configRepository,
      competitorEnabled,
      scheduledQueue,
      assertLease: async () => true,
      nowMs: Date.parse('2026-10-25T10:30:00.000Z'),
    });
    expect(count).toBe(6);
    expect(competitorEnabled.value).toBe(false);
    expect(configRepository.readConfiguration).toHaveBeenCalledOnce();
    const jobs = scheduledQueue.add.mock.calls.map(
      (call) =>
        call[1] as {
          domain: string;
          country: string;
          jobId: string;
        },
    );
    expect(jobs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ domain: 'primary', country: 'US' }),
        expect.objectContaining({ domain: 'primary', country: 'UK' }),
        expect.objectContaining({ domain: 'primary', country: 'DE' }),
        expect.objectContaining({ domain: 'primary', country: 'FR' }),
        expect.objectContaining({ domain: 'primary', country: 'ES' }),
        expect.objectContaining({ domain: 'primary', country: 'IT' }),
      ]),
    );
    expect(scheduledQueue.add.mock.calls.map((call) => call[2]?.delay)).toEqual(
      [0, 0, 1000, 2000, 3000, 4000],
    );
    expect(
      scheduledQueue.add.mock.calls.every(
        (call) =>
          (call[2] as { jobId?: string }).jobId ===
          (call[1] as { jobId: string }).jobId,
      ),
    ).toBe(true);
  });

  it('does not acknowledge the tick when queue admission is uncertain', async () => {
    const scheduledQueue = {
      add: vi.fn(async () => {
        throw new Error('ACK lost');
      }),
    };
    await expect(
      dispatchScheduledMonitorTick({
        env,
        configRepository: { readConfiguration: vi.fn(async () => []) },
        competitorEnabled: { value: true },
        scheduledQueue,
        assertLease: async () => true,
        nowMs: Date.parse('2026-10-25T10:30:00.000Z'),
      }),
    ).rejects.toThrow('ACK lost');
    expect(scheduledQueue.add).toHaveBeenCalledOnce();
  });

  it('stops admitting jobs immediately when the scheduler lease is lost', async () => {
    const scheduledQueue = { add: vi.fn(async () => ({ id: 'job' })) };
    const count = await dispatchScheduledMonitorTick({
      env,
      configRepository: { readConfiguration: vi.fn(async () => []) },
      competitorEnabled: { value: true },
      scheduledQueue,
      assertLease: async () => false,
      nowMs: Date.parse('2026-10-25T10:30:00.000Z'),
    });
    expect(count).toBe(0);
    expect(scheduledQueue.add).not.toHaveBeenCalled();
  });
});
