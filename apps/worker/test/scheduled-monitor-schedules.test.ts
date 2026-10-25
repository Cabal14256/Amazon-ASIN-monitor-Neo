import { describe, expect, it } from 'vitest';
import {
  buildScheduledMonitorDispatches,
  parseScheduledMonitorConfig,
  SCHEDULED_MONITOR_EU_COUNTRIES,
  shouldDispatchAt,
} from '../src/scheduled-monitor-schedules';

const env = {
  enabled: true,
  competitorEnabled: true,
  usIntervalMinutes: 30 as const,
  euIntervalMinutes: 60 as const,
  totalBatches: 3,
};

describe('scheduled monitor scheduler policy', () => {
  it('uses DB-backed intervals, switch and batch count with bounded fallbacks', () => {
    expect(
      parseScheduledMonitorConfig(
        [
          { configKey: 'MONITOR_US_SCHEDULE_MINUTES', configValue: '15' },
          { configKey: 'MONITOR_EU_SCHEDULE_MINUTES', configValue: 'invalid' },
          { configKey: 'COMPETITOR_MONITOR_ENABLED', configValue: 'false' },
          { configKey: 'MONITOR_BATCH_COUNT', configValue: '10000' },
        ],
        env,
      ),
    ).toEqual({
      enabled: true,
      competitorEnabled: false,
      usIntervalMinutes: 15,
      euIntervalMinutes: 60,
      totalBatches: 1000,
    });
    expect(parseScheduledMonitorConfig([], env)).toEqual(env);
    expect(
      parseScheduledMonitorConfig(
        [
          { configKey: 'MONITOR_US_SCHEDULE_MINUTES', configValue: null },
          { configKey: 'COMPETITOR_MONITOR_ENABLED', configValue: null },
        ],
        env,
      ),
    ).toEqual(env);
  });

  it('does not dispatch when disabled or between interval boundaries', () => {
    expect(
      buildScheduledMonitorDispatches(Date.parse('2026-10-25T10:01:00.000Z'), {
        ...env,
        enabled: false,
      }),
    ).toEqual([]);
    expect(
      buildScheduledMonitorDispatches(
        Date.parse('2026-10-25T10:01:00.000Z'),
        env,
      ),
    ).toEqual([]);
    expect(
      shouldDispatchAt(
        Date.parse('2026-10-25T10:01:00.000Z'),
        '2026-10-25T10:00:00.000Z',
        60,
      ),
    ).toBe(false);
    expect(
      shouldDispatchAt(
        Date.parse('2026-10-25T10:00:00.000Z'),
        '2026-10-25T10:00:00.000Z',
        60,
      ),
    ).toBe(true);
  });

  it('creates one US primary task and no independent US competitor task', () => {
    const dispatches = buildScheduledMonitorDispatches(
      Date.parse('2026-10-25T10:00:00.000Z'),
      env,
    );
    const us = dispatches.filter((item) => item.job.country === 'US');
    expect(us).toHaveLength(1);
    expect(us[0].job.domain).toBe('primary');
    expect(us[0].delayMs).toBe(0);
  });

  it('creates ordered EU primary and competitor pairs with one-second offsets', () => {
    const dispatches = buildScheduledMonitorDispatches(
      Date.parse('2026-10-25T10:00:00.000Z'),
      env,
    ).filter((item) => item.job.country !== 'US');
    expect(dispatches).toHaveLength(SCHEDULED_MONITOR_EU_COUNTRIES.length * 2);
    for (const [index, country] of SCHEDULED_MONITOR_EU_COUNTRIES.entries()) {
      const pair = dispatches.filter((item) => item.job.country === country);
      expect(pair.map((item) => item.job.domain).sort()).toEqual([
        'competitor',
        'primary',
      ]);
      expect(pair.map((item) => item.delayMs)).toEqual([
        index * 1000,
        index * 1000,
      ]);
      expect(pair[0].job.jobId).not.toBe(pair[1].job.jobId);
      expect(pair[0].job.taskId).not.toBe(pair[1].job.taskId);
      expect(pair[0].job.batchConfig).toEqual(pair[1].job.batchConfig);
    }
  });

  it('keeps stable identities for repeated ticks in one slot', () => {
    const first = buildScheduledMonitorDispatches(
      Date.parse('2026-10-25T10:00:01.000Z'),
      env,
    );
    const second = buildScheduledMonitorDispatches(
      Date.parse('2026-10-25T10:00:59.000Z'),
      env,
    );
    expect(first.map((item) => item.job.jobId)).toEqual(
      second.map((item) => item.job.jobId),
    );
    expect(new Set(first.map((item) => item.job.jobId)).size).toBe(
      first.length,
    );
  });
});
