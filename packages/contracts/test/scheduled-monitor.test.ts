import { describe, expect, it } from 'vitest';
import {
  primaryMonitorJobSchema,
  triggerMonitorRequestSchema,
} from '../src/domains/monitor';
import {
  buildScheduledMonitorJobId,
  scheduledMonitorJobSchema,
  scheduledMonitorPlanSchema,
  type ScheduledMonitorPlan,
} from '../src/internal/scheduled-monitor';

const plan: ScheduledMonitorPlan = {
  domain: 'primary',
  country: 'US',
  plannedSlot: '2026-10-03T12:30:00.000Z',
  intervalMinutes: 30,
  batchConfig: { batchIndex: 0, totalBatches: 1 },
};
const job = {
  ...plan,
  version: 1,
  source: 'scheduled',
  taskType: 'scheduled-monitor',
  actor: { kind: 'system', purpose: 'scheduled-monitor' },
  taskId: 'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa',
  jobId: buildScheduledMonitorJobId(plan),
  requestedAt: '2026-10-03T12:30:01.000Z',
  createdAt: '2026-10-03T12:30:02.000Z',
  expiresAt: '2026-10-10T12:30:02.000Z',
};

describe('private scheduled monitor contracts', () => {
  it('keeps the system actor separate from manual task and public trigger shapes', () => {
    expect(scheduledMonitorJobSchema.parse(job)).toEqual(job);
    expect(primaryMonitorJobSchema.safeParse(job).success).toBe(false);
    expect(triggerMonitorRequestSchema.safeParse(job).success).toBe(false);
    expect(
      scheduledMonitorJobSchema.safeParse({ ...job, userId: 'ordinary-user' })
        .success,
    ).toBe(false);
  });

  it.each([
    { source: 'manual' },
    { version: 2 },
    { taskType: 'monitor' },
    { actor: { kind: 'user', purpose: 'scheduled-monitor' } },
    {
      actor: {
        kind: 'system',
        purpose: 'scheduled-monitor',
        userId: 'ordinary-user',
      },
    },
    { domain: 'other' },
    { country: ' us ' },
    { countries: ['US'] },
    { jobId: 'neo-primary-monitor-scheduled-another-slot' },
    { taskId: 'not-a-uuid' },
  ])('rejects altered or mixed identity %#', (change) => {
    expect(
      scheduledMonitorJobSchema.safeParse({ ...job, ...change }).success,
    ).toBe(false);
  });

  it.each([
    { plannedSlot: '2026-10-03T12:30:00Z' },
    { plannedSlot: '2026-10-03T12:30:01.000Z' },
    { plannedSlot: '2026-02-30T12:30:00.000Z' },
    { requestedAt: '2026-10-03T12:29:59.999Z' },
    { createdAt: '2026-10-03T12:30:00.000Z' },
    { expiresAt: job.createdAt },
  ])('rejects untrusted or inconsistent timestamps %#', (change) => {
    expect(
      scheduledMonitorJobSchema.safeParse({ ...job, ...change }).success,
    ).toBe(false);
  });

  it('preserves the original slot and job ID for a later competitor follow-up', () => {
    const competitor = { ...plan, domain: 'competitor' as const };
    const queued = {
      ...job,
      ...competitor,
      jobId: buildScheduledMonitorJobId(competitor),
      requestedAt: '2026-10-03T13:05:00.000Z',
      createdAt: '2026-10-03T13:05:00.000Z',
    };
    expect(scheduledMonitorJobSchema.parse(queued).plannedSlot).toBe(
      plan.plannedSlot,
    );
    expect(queued.jobId).toBe(
      'neo-competitor-monitor-scheduled-20261003T1230-US-b0of1',
    );
    expect(queued.jobId).not.toContain(':');
    expect(queued.jobId).not.toBe(job.jobId);
  });

  it.each([
    { batchIndex: -1, totalBatches: 3 },
    { batchIndex: 3, totalBatches: 3 },
    { batchIndex: 0, totalBatches: 0 },
    { batchIndex: 0, totalBatches: 1001 },
    { batchIndex: 0.5, totalBatches: 2 },
    { batchIndex: 0, totalBatches: 2.5 },
    { batchIndex: 0, totalBatches: 1, extra: true },
  ])('rejects invalid batch configuration %#', (batchConfig) => {
    expect(
      scheduledMonitorPlanSchema.safeParse({ ...plan, batchConfig }).success,
    ).toBe(false);
  });

  it('rejects a valid-range batch that does not belong to the planned slot', () => {
    const slot = Date.parse(plan.plannedSlot) / (30 * 60000);
    const expected = slot % 3;
    const valid = {
      ...plan,
      batchConfig: { batchIndex: expected, totalBatches: 3 },
    };
    expect(scheduledMonitorPlanSchema.safeParse(valid).success).toBe(true);
    expect(
      scheduledMonitorPlanSchema.safeParse({
        ...valid,
        batchConfig: { batchIndex: (expected + 1) % 3, totalBatches: 3 },
      }).success,
    ).toBe(false);
  });

  it('includes country, domain and total batch count in stable identities', () => {
    const ids = [
      plan,
      { ...plan, country: 'DE' as const },
      { ...plan, domain: 'competitor' as const },
    ].map(buildScheduledMonitorJobId);
    expect(new Set(ids).size).toBe(3);
    const slot = Date.parse(plan.plannedSlot) / (plan.intervalMinutes * 60000);
    expect(
      buildScheduledMonitorJobId({
        ...plan,
        batchConfig: { batchIndex: slot % 2, totalBatches: 2 },
      }),
    ).not.toBe(ids[0]);
  });
});
