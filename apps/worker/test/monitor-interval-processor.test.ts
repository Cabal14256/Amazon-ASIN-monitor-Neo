import type { Job } from 'bullmq';
import { UnrecoverableError } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMonitorIntervalProcessor } from '../src/monitor-interval-processor';
import {
  installMonitorIntervalSchedule,
  MONITOR_INTERVAL_JOB,
  MONITOR_INTERVAL_JOB_OPTIONS,
  MONITOR_INTERVAL_SCHEDULER,
} from '../src/monitor-interval-schedules';

function fixture() {
  const repository = {
    reconcile: vi.fn(async () => ({ processed: false, deferred: false })),
  };
  const queue = { add: vi.fn() };
  const stopping = vi.fn(() => false);
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const env = {
    AUTH_DATA_AUTHORITY: 'postgresql' as const,
    ANALYTICS_STATUS_INTERVAL_ENABLED: true,
  };
  return {
    repository,
    queue,
    stopping,
    log,
    env,
    process: createMonitorIntervalProcessor(
      env,
      repository,
      queue,
      stopping,
      log,
    ),
  };
}
const job = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 'interval-test-job',
    name: MONITOR_INTERVAL_JOB,
    data: { schemaVersion: 1 },
    ...overrides,
  } as Job);
describe('status interval maintenance jobs', () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([
    { name: 'unknown' },
    { id: undefined },
    { id: 'x'.repeat(2001) },
    { data: null },
    { data: [] },
    { data: {} },
    { data: { schemaVersion: 2 } },
    { data: { schemaVersion: 1, sql: 'secret-payload' } },
  ])(
    'rejects untrusted job shape before database access: %j',
    async (overrides) => {
      const f = fixture();
      await expect(f.process(job(overrides))).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
      expect(f.repository.reconcile).not.toHaveBeenCalled();
      expect(JSON.stringify(f.log.warn.mock.calls)).not.toContain(
        'secret-payload',
      );
    },
  );
  it('honors authority and disabled maintenance before accessing the database', async () => {
    const f = fixture();
    for (const env of [
      { ...f.env, ANALYTICS_STATUS_INTERVAL_ENABLED: false },
      { ...f.env, AUTH_DATA_AUTHORITY: 'legacy-mysql' as const },
    ]) {
      await expect(
        createMonitorIntervalProcessor(
          env,
          f.repository,
          f.queue,
          f.stopping,
          f.log,
        )(job()),
      ).rejects.toBeInstanceOf(UnrecoverableError);
    }
    expect(f.repository.reconcile).not.toHaveBeenCalled();
  });
  it('processes other keys after a deferred key and avoids empty polling logs', async () => {
    const f = fixture();
    f.repository.reconcile
      .mockResolvedValueOnce({ processed: false, deferred: true })
      .mockResolvedValueOnce({ processed: true, deferred: false });
    expect(await f.process(job())).toEqual({
      processed: 1,
      deferred: 1,
      continued: false,
    });
    expect(f.log.warn).toHaveBeenCalledOnce();
    expect(f.queue.add).not.toHaveBeenCalled();
    f.log.warn.mockClear();
    expect(await f.process(job())).toEqual({
      processed: 0,
      deferred: 0,
      continued: false,
    });
    expect(f.log.info).not.toHaveBeenCalled();
    expect(f.log.warn).not.toHaveBeenCalled();
  });
  it('bounds batches and uses the same durable continuation ID when a Redis acknowledgement is lost', async () => {
    const f = fixture();
    f.repository.reconcile.mockResolvedValue({
      processed: true,
      deferred: false,
    });
    f.queue.add.mockRejectedValueOnce(new Error('redis-secret'));
    await expect(f.process(job())).rejects.toThrow(
      'Monitor interval maintenance failed',
    );
    expect(await f.process(job())).toEqual({
      processed: 100,
      deferred: 0,
      continued: true,
    });
    expect(f.repository.reconcile).toHaveBeenCalledTimes(200);
    expect(f.queue.add.mock.calls[0]).toEqual(f.queue.add.mock.calls[1]);
    expect(f.queue.add.mock.calls[1]).toEqual([
      MONITOR_INTERVAL_JOB,
      { schemaVersion: 1 },
      {
        ...MONITOR_INTERVAL_JOB_OPTIONS,
        jobId: expect.stringMatching(/^monitor-interval-next-[a-f0-9]{64}$/),
        delay: 1000,
      },
    ]);
    expect(JSON.stringify(f.log.error.mock.calls)).not.toContain(
      'redis-secret',
    );
  });
  it('stops before accessing more data and never persists driver errors', async () => {
    const f = fixture();
    f.stopping.mockReturnValue(true);
    await expect(f.process(job())).rejects.toThrow(
      'Monitor interval maintenance failed',
    );
    expect(f.repository.reconcile).not.toHaveBeenCalled();
    f.stopping.mockReturnValue(false);
    f.repository.reconcile.mockRejectedValue(
      new Error('postgres://user:secret@host and SQL payload'),
    );
    await expect(f.process(job())).rejects.toThrow(
      'Monitor interval maintenance failed',
    );
    expect(JSON.stringify(f.log.error.mock.calls)).not.toContain('secret');
    expect(f.queue.add).not.toHaveBeenCalled();
  });
  it('installs one stable 30-second scheduler with bounded job retention and retries', async () => {
    const queue = { upsertJobScheduler: vi.fn() };
    await installMonitorIntervalSchedule(queue);
    expect(queue.upsertJobScheduler).toHaveBeenCalledExactlyOnceWith(
      MONITOR_INTERVAL_SCHEDULER,
      { every: 30000 },
      {
        name: MONITOR_INTERVAL_JOB,
        data: { schemaVersion: 1 },
        opts: MONITOR_INTERVAL_JOB_OPTIONS,
      },
    );
  });
});
