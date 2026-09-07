import type { AuthMaintenanceRepositoryPort } from '@asin-monitor/db';
import { UnrecoverableError, type Job } from 'bullmq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAuthMaintenanceProcessor } from '../src/auth-maintenance-processor';

afterEach(() => vi.restoreAllMocks());

function fixture(authority: 'postgresql' | 'legacy-mysql' = 'postgresql') {
  const done = { processed: 0, hasMore: false, busy: false };
  const repository = {
    cleanupSessions: vi
      .fn<AuthMaintenanceRepositoryPort['cleanupSessions']>()
      .mockResolvedValue(done),
    archiveAuditLogs: vi
      .fn<AuthMaintenanceRepositoryPort['archiveAuditLogs']>()
      .mockResolvedValue(done),
  };
  const queue = { add: vi.fn() };
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const process = createAuthMaintenanceProcessor(
    { AUTH_DATA_AUTHORITY: authority },
    repository,
    queue,
    log,
  );
  const job = (overrides: Record<string, unknown> = {}) =>
    ({
      id: 'fixture-67',
      name: 'session-cleanup',
      data: { schemaVersion: 1 },
      ...overrides,
    } as Job);
  return { repository, queue, log, process, job };
}

describe('Authentication maintenance processor', () => {
  it.each([
    { name: 'unknown' },
    { data: null },
    { data: [] },
    { data: {} },
    { data: { schemaVersion: 2 } },
    { data: { schemaVersion: 1, sql: 'fixture-secret' } },
    { id: undefined },
    { id: '' },
    { id: 'x'.repeat(2001) },
  ])(
    'rejects malformed persisted jobs without retries or database access: %j',
    async (overrides) => {
      const f = fixture();
      await expect(f.process(f.job(overrides))).rejects.toBeInstanceOf(
        UnrecoverableError,
      );
      expect(f.repository.cleanupSessions).not.toHaveBeenCalled();
      expect(f.repository.archiveAuditLogs).not.toHaveBeenCalled();
      expect(f.queue.add).not.toHaveBeenCalled();
      expect(JSON.stringify(f.log.warn.mock.calls)).not.toContain(
        'fixture-secret',
      );
    },
  );

  it('rejects Legacy authority before touching either database method', async () => {
    const f = fixture('legacy-mysql');
    await expect(f.process(f.job())).rejects.toBeInstanceOf(UnrecoverableError);
    expect(f.repository.cleanupSessions).not.toHaveBeenCalled();
    expect(f.repository.archiveAuditLogs).not.toHaveBeenCalled();
  });

  it.each(['session-cleanup', 'audit-archive'])(
    'drains %s with one frozen cutoff and sums committed batches',
    async (operation) => {
      const f = fixture();
      const now = new Date('2026-09-07T01:02:03Z');
      vi.spyOn(Date, 'now').mockReturnValue(now.getTime());
      const method =
        operation === 'session-cleanup'
          ? f.repository.cleanupSessions
          : f.repository.archiveAuditLogs;
      method
        .mockResolvedValueOnce({ processed: 1000, hasMore: true, busy: false })
        .mockResolvedValueOnce({ processed: 3, hasMore: false, busy: false });
      await expect(f.process(f.job({ name: operation }))).resolves.toEqual({
        operation,
        processed: 1003,
        continued: false,
      });
      expect(method.mock.calls).toEqual(
        Array(2).fill(
          operation === 'session-cleanup' ? [1000, now] : [90, 1000, now],
        ),
      );
      expect(f.queue.add).not.toHaveBeenCalled();
    },
  );

  it.each([
    { processed: 0, hasMore: true, busy: true },
    { processed: 0, hasMore: true, busy: false },
  ])(
    'retries contention or skipped locked rows without a tight loop',
    async (result) => {
      const f = fixture();
      f.repository.cleanupSessions.mockResolvedValue(result);
      await expect(f.process(f.job())).rejects.toThrow(
        'Authentication maintenance is busy',
      );
      expect(f.repository.cleanupSessions).toHaveBeenCalledOnce();
      expect(f.log.warn).toHaveBeenCalledWith('认证维护遇到锁竞争，将重试', {
        operation: 'session-cleanup',
        processed: 0,
        reason: 'maintenance_busy',
      });
      expect(f.queue.add).not.toHaveBeenCalled();
    },
  );

  it('caps one attempt at 100 batches and deduplicates its next hop after a lost queue acknowledgement', async () => {
    const f = fixture();
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    f.repository.cleanupSessions.mockResolvedValue({
      processed: 1000,
      hasMore: true,
      busy: false,
    });
    f.queue.add
      .mockRejectedValueOnce(new Error('fixture-redis-password'))
      .mockResolvedValueOnce({});
    await expect(f.process(f.job())).rejects.toThrow(
      'Authentication maintenance failed',
    );
    expect(f.repository.cleanupSessions).toHaveBeenCalledTimes(100);
    await expect(f.process(f.job())).resolves.toEqual({
      operation: 'session-cleanup',
      processed: 100000,
      continued: true,
    });
    expect(f.repository.cleanupSessions).toHaveBeenCalledTimes(200);
    const [first, retry] = f.queue.add.mock.calls;
    expect(first).toEqual(retry);
    expect(first).toEqual([
      'session-cleanup',
      { schemaVersion: 1 },
      {
        jobId: expect.stringMatching(/^auth-maintenance-next-[a-f0-9]{64}$/),
        delay: 1000,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 86400, count: 50 },
        removeOnFail: { age: 604800, count: 200 },
      },
    ]);
    expect(JSON.stringify(f.log.error.mock.calls)).not.toContain(
      'fixture-redis-password',
    );
  });

  it('yields after the time budget even before the batch cap', async () => {
    const f = fixture();
    let clock = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);
    f.repository.archiveAuditLogs.mockImplementation(async () => {
      clock += 15_001;
      return { processed: 1000, hasMore: true, busy: false };
    });
    await expect(
      f.process(f.job({ name: 'audit-archive' })),
    ).resolves.toMatchObject({ processed: 2000, continued: true });
    expect(f.repository.archiveAuditLogs).toHaveBeenCalledTimes(2);
    expect(f.queue.add.mock.calls[0]?.[0]).toBe('audit-archive');
  });

  it('reports committed counts but persists only a fixed failure when a later database batch fails', async () => {
    const f = fixture();
    f.repository.cleanupSessions
      .mockResolvedValueOnce({ processed: 1000, hasMore: true, busy: false })
      .mockRejectedValueOnce(
        new Error('SELECT password FROM fixture-private-user'),
      );
    let failure: unknown;
    try {
      await f.process(f.job());
    } catch (error) {
      failure = error;
    }
    expect((failure as Error).message).toBe(
      'Authentication maintenance failed',
    );
    expect((failure as Error).stack).not.toContain('fixture-private-user');
    expect(f.log.error).toHaveBeenCalledWith('认证维护任务失败', {
      operation: 'session-cleanup',
      processed: 1000,
      reason: 'maintenance_failed',
    });
    expect(f.queue.add).not.toHaveBeenCalled();
  });
});
