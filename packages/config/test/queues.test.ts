import { describe, expect, it } from 'vitest';

import {
  QUEUE_NAMES,
  resolveQueueSelection,
  resolveScheduledMonitorSelection,
  SCHEDULED_MONITOR_PHYSICAL_QUEUE,
  SCHEDULED_MONITOR_QUEUE,
} from '../src/queues';

describe('private scheduled monitor queue selection', () => {
  it('keeps the private selector outside the public queue registry', () => {
    expect(QUEUE_NAMES).not.toContain(SCHEDULED_MONITOR_QUEUE);
    expect(resolveQueueSelection('scheduled-monitor')).toEqual({
      enabledQueues: [],
      unknownQueues: ['scheduled-monitor'],
    });
  });

  it('requires explicit opt-in and exposes only a stable physical name', () => {
    expect(resolveScheduledMonitorSelection(undefined)).toEqual({
      enabled: false,
    });
    expect(resolveScheduledMonitorSelection('all')).toEqual({ enabled: false });
    expect(
      resolveScheduledMonitorSelection('monitor, scheduled-monitor'),
    ).toEqual({ enabled: true });
    expect(SCHEDULED_MONITOR_PHYSICAL_QUEUE).toBe(
      'scheduled-monitor-task-queue',
    );
  });
});
