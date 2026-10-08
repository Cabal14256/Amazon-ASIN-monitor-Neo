import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { scheduledMonitorJobDigest } from '../src/domain/scheduled-monitor-policy';
import { scheduledMonitorSnapshotDigest } from '../src/domain/scheduled-monitor-run';
import { PgScheduledMonitorRunRepository } from '../src/repositories/scheduled-monitor-run-repository';
import { scheduledJob } from './helpers/scheduled-monitor-fixtures';

function fixture(
  domain: 'primary' | 'competitor',
  options: {
    missing?: 'first' | 'always';
    lostCommit?: boolean;
    onRelease?: () => void;
  } = {},
) {
  const job = scheduledJob(domain);
  const now = new Date(Date.parse(job.createdAt) + 1000);
  const row = {
    task_id: job.taskId,
    job_id: job.jobId,
    job_digest: scheduledMonitorJobDigest(job),
    job,
    domain,
    country: job.country,
    actor_kind: 'system',
    actor_purpose: 'scheduled-monitor',
    planned_slot: new Date(job.plannedSlot),
    requested_at: new Date(job.requestedAt),
    created_at: new Date(job.createdAt),
    expires_at: new Date(job.expiresAt),
    interval_minutes: job.intervalMinutes,
    batch_index: job.batchConfig.batchIndex,
    total_batches: job.batchConfig.totalBatches,
    groups: [],
    snapshot_digest: scheduledMonitorSnapshotDigest(job, []),
    total_members: 0,
    state: 'pending',
    business_completed_at: null,
    completed_at: null,
    cancel_requested_at: null as Date | null,
    result: null,
    follow_up_job: null,
    follow_up_digest: null,
    follow_up_requested_at: null,
  };
  const clients: {
    query: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  }[] = [];
  const connect = vi.fn(async () => {
    // Model an RR snapshot captured before a concurrent acceptance commits.
    // Only a new connection/transaction may observe that accepted original row.
    const absent =
      options.missing === 'always' ||
      (options.missing === 'first' && clients.length === 0);
    const query = vi.fn(async (text: string) => {
      if (text.startsWith('SELECT * FROM'))
        return { rows: absent ? [] : [{ ...row }] };
      if (text.includes('AS now_ms'))
        return { rows: [{ now_ms: String(now.getTime()) }] };
      if (text.includes("SET state='running'")) row.state = 'running';
      if (text.includes('SET cancel_requested_at='))
        row.cancel_requested_at = now;
      if (text === 'COMMIT' && options.lostCommit)
        throw new Error('simulated COMMIT acknowledgment loss');
      return { rows: [] };
    });
    const release = vi.fn(options.onRelease);
    clients.push({ query, release });
    return Object.assign(new EventEmitter(), {
      query,
      release,
    }) as unknown as PoolClient;
  });
  const repository = new PgScheduledMonitorRunRepository(
    { connect } as unknown as Pool,
    domain,
  );
  return { job, now, row, repository, connect, clients };
}

describe.each(['primary', 'competitor'] as const)(
  '%s required scheduled run after concurrent acceptance',
  (domain) => {
    it.each(['start', 'requestCancellation'] as const)(
      'retries a stale missing-row snapshot for %s and preserves the original accepted identity',
      async (operation) => {
        const { repository, job, now, connect, clients } = fixture(domain, {
          missing: 'first',
        });
        try {
          const run = await repository[operation](job);
          expect(run.job).toEqual(job);
          expect(run.groups).toEqual([]);
          expect(run.state).toBe(operation === 'start' ? 'running' : 'pending');
          expect(run.cancelRequestedAt).toBe(
            operation === 'requestCancellation' ? now.toISOString() : null,
          );
          expect(connect).toHaveBeenCalledTimes(2);
          expect(clients[0].release).toHaveBeenCalledExactlyOnceWith(true);
          expect(clients[1].release).toHaveBeenCalledExactlyOnceWith(false);
          expect(
            clients[0].query.mock.calls.some(([text]) => text === 'COMMIT'),
          ).toBe(false);
          expect(
            clients[1].query.mock.calls.filter(([text]) => text === 'COMMIT'),
          ).toHaveLength(1);
          expect(
            clients
              .flatMap(({ query }) => query.mock.calls)
              .every(
                ([text]) =>
                  !text.includes('variant_groups') &&
                  !text.includes('FROM "public"."asins"'),
              ),
          ).toBe(true);
        } finally {
          repository.close();
        }
      },
    );
    it('bounds genuine absence to three fresh transactions and still reports identity', async () => {
      const { repository, job, connect, clients } = fixture(domain, {
        missing: 'always',
      });
      try {
        await expect(repository.start(job)).rejects.toMatchObject({
          code: 'identity',
        });
        expect(connect).toHaveBeenCalledTimes(3);
        expect(
          clients.every(({ release }) => release.mock.calls.length === 1),
        ).toBe(true);
        expect(
          clients
            .flatMap(({ query }) => query.mock.calls)
            .some(([text]) => text === 'COMMIT'),
        ).toBe(false);
        expect(repository.getDiagnostics().active).toBe(0);
      } finally {
        repository.close();
      }
    });
    it.each(['requestCancellation', 'read'] as const)(
      'rejects a foreign immutable identity in %s immediately without a retry or state change',
      async (operation) => {
        const { repository, job, row, connect } = fixture(domain);
        try {
          await expect(
            repository[operation]({
              ...job,
              expiresAt: new Date(Date.parse(job.expiresAt) + 1).toISOString(),
            }),
          ).rejects.toMatchObject({ code: 'identity' });
          expect(connect).toHaveBeenCalledTimes(1);
          expect(row.state).toBe('pending');
          expect(row.cancel_requested_at).toBeNull();
        } finally {
          repository.close();
        }
      },
    );
    it('refreshes an optional read after stale absence and returns only the original accepted run', async () => {
      const { repository, job, connect, clients } = fixture(domain, {
        missing: 'first',
      });
      try {
        expect(await repository.read(job)).toMatchObject({
          job,
          state: 'pending',
        });
        expect(connect).toHaveBeenCalledTimes(2);
        expect(clients[0].release).toHaveBeenCalledExactlyOnceWith(true);
        expect(clients[1].release).toHaveBeenCalledExactlyOnceWith(false);
        expect(
          clients
            .flatMap(({ query }) => query.mock.calls)
            .every(([text]) => !/^(INSERT|UPDATE|DELETE)\b/.test(text)),
        ).toBe(true);
      } finally {
        repository.close();
      }
    });
    it('bounds genuine optional absence to three fresh read transactions without creating a run', async () => {
      const { repository, job, connect, clients } = fixture(domain, {
        missing: 'always',
      });
      try {
        await expect(repository.read(job)).resolves.toBeUndefined();
        expect(connect).toHaveBeenCalledTimes(3);
        expect(
          clients.every(({ release }) => release.mock.calls.length === 1),
        ).toBe(true);
        expect(
          clients
            .flatMap(({ query }) => query.mock.calls)
            .every(([text]) => !/^(COMMIT|INSERT|UPDATE|DELETE)\b/.test(text)),
        ).toBe(true);
      } finally {
        repository.close();
      }
    });
    it.each(['start', 'read'] as const)(
      'honors an abort between stale-snapshot %s attempts without another connection or write',
      async (operation) => {
        const controller = new AbortController();
        const { repository, job, row, connect } = fixture(domain, {
          missing: 'first',
          onRelease: () => controller.abort(),
        });
        try {
          await expect(
            repository[operation](job, controller.signal),
          ).rejects.toMatchObject({ code: 'cancelled' });
          expect(connect).toHaveBeenCalledTimes(1);
          expect(row.state).toBe('pending');
          expect(repository.getDiagnostics().active).toBe(0);
        } finally {
          repository.close();
        }
      },
    );
    it.each(['start', 'read'] as const)(
      'does not retry an unknown %s COMMIT after acquiring the original row',
      async (operation) => {
        const { repository, job, connect } = fixture(domain, {
          lostCommit: true,
        });
        try {
          await expect(repository[operation](job)).rejects.toMatchObject({
            code: 'commit-uncertain',
          });
          expect(connect).toHaveBeenCalledTimes(1);
        } finally {
          repository.close();
        }
      },
    );
  },
);
