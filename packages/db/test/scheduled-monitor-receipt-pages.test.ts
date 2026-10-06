import { EventEmitter } from 'node:events';
import type { Pool, PoolClient } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { scheduledMonitorJobDigest } from '../src/domain/scheduled-monitor-policy';
import {
  freezeScheduledMonitorSnapshot,
  scheduledMonitorGroupOperation,
  scheduledMonitorSnapshotDigest,
} from '../src/domain/scheduled-monitor-run';
import { VARIANT_CHECK_RECEIPT_MAX_BYTES } from '../src/domain/variant-check-receipt';
import { PgScheduledMonitorRunRepository } from '../src/repositories/scheduled-monitor-run-repository';
import {
  scheduledGroup,
  scheduledJob,
} from './helpers/scheduled-monitor-fixtures';

function fixture(
  domain: 'primary' | 'competitor',
  count = 3,
  options: {
    receiptCount?: number;
    gap?: boolean;
    forgedOrdinal?: number;
    oversized?: boolean;
    malformed?: boolean;
    pauseSecondPage?: boolean;
  } = {},
) {
  const job = scheduledJob(domain);
  const now = new Date(Date.parse(job.createdAt) + 1000);
  const groups = freezeScheduledMonitorSnapshot(
    job,
    Array.from({ length: count }, (_, index) =>
      scheduledGroup(domain, `group-${String(index).padStart(4, '0')}`),
    ),
    [],
  );
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
    groups,
    snapshot_digest: scheduledMonitorSnapshotDigest(job, groups),
    total_members: 0,
    state: 'running',
    business_completed_at: null as Date | null,
    completed_at: null,
    cancel_requested_at: null,
    result: null as unknown,
    follow_up_job: null as unknown,
    follow_up_digest: null as string | null,
    follow_up_requested_at: null as Date | null,
  };
  const pages: number[] = [];
  const statements: { text: string; values: unknown[] }[] = [];
  let resume!: () => void;
  let paused = false;
  const wait = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const connect = vi.fn(async () => {
    const query = vi.fn(async (text: string, values: unknown[] = []) => {
      statements.push({ text, values });
      if (/FROM .*_group_receipts/.test(text)) {
        if (text.includes('count(*)'))
          return {
            rows: [{ receipt_count: String(options.receiptCount ?? count) }],
          };
        // Refuse the unsafe request BEFORE manufacturing any payload. A legal
        // run can contain 1,000 independent 32 MiB values; a driver must never
        // be asked to buffer that whole run in one query result.
        if (!/ordinal\s*>\s*\$2/.test(text) || !/LIMIT 1\s*$/.test(text))
          throw new Error('unsafe receipt transport can buffer 32 GiB');
        const ordinal = Number(values[1]) + 1;
        pages.push(ordinal);
        if (options.pauseSecondPage && ordinal === 1 && !paused) {
          paused = true;
          await wait;
        }
        if (ordinal >= count) return { rows: [] };
        const group = groups[ordinal];
        const operation = scheduledMonitorGroupOperation(job, group);
        const result = {
          isBroken: false,
          brokenASINs: [],
          brokenByType: {},
          groupSnapshot: {
            id: group.group.id,
            name: group.group.name,
            country: group.country,
            children: [],
          },
          details: { results: [] },
          raw: options.oversized
            ? 'x'.repeat(VARIANT_CHECK_RECEIPT_MAX_BYTES + 1)
            : 'untruncated raw',
        };
        return {
          rows: [
            {
              ...Object.fromEntries(
                Object.entries(operation).map(([key, value]) => [
                  key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`),
                  value,
                ]),
              ),
              ordinal: options.gap ? ordinal + 1 : ordinal,
              request_hash:
                options.forgedOrdinal === ordinal
                  ? 'a'.repeat(64)
                  : operation.requestHash,
              result: options.malformed
                ? { ...result, isBroken: 'corrupt' }
                : result,
              completed_at: now,
            },
          ],
        };
      }
      if (text.startsWith('SELECT * FROM')) return { rows: [{ ...row }] };
      if (text.includes('AS now_ms'))
        return { rows: [{ now_ms: String(now.getTime()) }] };
      if (text.includes("SET state='business-completed'")) {
        row.state = 'business-completed';
        row.business_completed_at = new Date(values[1] as string);
        row.result = JSON.parse(values[2] as string);
        row.follow_up_job =
          values[3] === null ? null : JSON.parse(values[3] as string);
        row.follow_up_digest = values[4] as string | null;
        row.follow_up_requested_at =
          values[5] === null ? null : new Date(values[5] as string);
        return { rows: [{ task_id: job.taskId }] };
      }
      return { rows: [] };
    });
    return Object.assign(new EventEmitter(), {
      query,
      release: vi.fn(),
    }) as unknown as PoolClient;
  });
  const repository = new PgScheduledMonitorRunRepository(
    { connect } as unknown as Pool,
    domain,
    options.pauseSecondPage
      ? { durationMs: 1000, statementTimeoutMs: 100 }
      : undefined,
  );
  const summary = {
    version: 1 as const,
    totalGroups: count,
    totalMembers: 0,
    brokenGroups: 0,
    brokenMembers: 0,
  };
  const updates = () =>
    statements.filter(({ text }) =>
      text.includes("SET state='business-completed'"),
    );
  return {
    repository,
    job,
    row,
    pages,
    statements,
    summary,
    updates,
    resume,
    connect,
  };
}

describe.each(['primary', 'competitor'] as const)(
  '%s scheduled receipt transport stays bounded',
  (domain) => {
    it('validates all 1,000 receipts with one-row keyset pages and one atomic completion', async () => {
      const f = fixture(domain, 1000);
      try {
        const complete = await f.repository.completeBusiness(f.job, f.summary);
        expect(complete.state).toBe('business-completed');
        expect(complete.result).toEqual(f.summary);
        expect(f.pages).toEqual(
          Array.from({ length: 1000 }, (_, index) => index),
        );
        expect(f.updates()).toHaveLength(1);
        expect(
          f.statements.every(({ text }) => !/SUM\(|result::text/i.test(text)),
        ).toBe(true);
        expect(await f.repository.completeBusiness(f.job, f.summary)).toEqual(
          complete,
        );
        expect(f.updates()).toHaveLength(1);
        expect(f.pages).toHaveLength(1000);
      } finally {
        f.repository.close();
      }
    }, 15_000);
    it.each([2, 4])(
      'rejects missing/extra metadata count %s before fetching any result',
      async (receiptCount) => {
        const f = fixture(domain, 3, { receiptCount });
        try {
          await expect(
            f.repository.completeBusiness(f.job, f.summary),
          ).rejects.toMatchObject({ code: 'state' });
          expect(f.pages).toEqual([]);
          expect(f.updates()).toEqual([]);
          expect(f.row.state).toBe('running');
        } finally {
          f.repository.close();
        }
      },
    );
    it.each([{ gap: true }, { forgedOrdinal: 2 }])(
      'preserves all identity checks without partially completing %j',
      async (options) => {
        const f = fixture(domain, 3, options);
        try {
          await expect(
            f.repository.completeBusiness(f.job, f.summary),
          ).rejects.toMatchObject({ code: 'identity' });
          expect(f.pages.length).toBeGreaterThan(0);
          expect(f.updates()).toEqual([]);
          expect(f.row.state).toBe('running');
        } finally {
          f.repository.close();
        }
      },
    );
    it.each([{ oversized: true }, { malformed: true }])(
      'classifies a permanently invalid stored result as identity without an automatic retry %j',
      async (options) => {
        const f = fixture(domain, 1, options);
        try {
          await expect(
            f.repository.completeBusiness(f.job, f.summary),
          ).rejects.toMatchObject({ code: 'identity' });
          expect(f.connect).toHaveBeenCalledTimes(1);
          expect(f.pages).toEqual([0]);
          expect(f.updates()).toEqual([]);
          expect(f.row.state).toBe('running');
        } finally {
          f.repository.close();
        }
      },
      15_000,
    );
    it('keeps a timed-out run inspectable and retries only completion after late SQL settles', async () => {
      vi.useFakeTimers();
      const f = fixture(domain, 3, { pauseSecondPage: true });
      try {
        const pending = f.repository.completeBusiness(f.job, f.summary);
        const outcome = pending.catch((error: unknown) => error);
        await vi.waitFor(() => expect(f.pages).toEqual([0, 1]));
        await vi.advanceTimersByTimeAsync(1000);
        expect(await outcome).toMatchObject({ code: 'timeout' });
        expect(f.row.state).toBe('running');
        expect(f.updates()).toEqual([]);
        expect(f.repository.getDiagnostics().active).toBe(1);
        f.resume();
        await vi.waitFor(() =>
          expect(f.repository.getDiagnostics().active).toBe(0),
        );
        expect((await f.repository.read(f.job))?.state).toBe('running');
        expect(
          (await f.repository.completeBusiness(f.job, f.summary)).state,
        ).toBe('business-completed');
        expect(f.updates()).toHaveLength(1);
      } finally {
        f.resume();
        f.repository.close();
        vi.useRealTimers();
      }
    });
  },
);
