import { describe, expect, it } from 'vitest';
import { competitorMonitorTriggerResultSchema } from '../src/domains/competitor';
import {
  competitorMonitorJobSchema,
  triggerCompetitorMonitorAsyncRequestSchema,
  triggerCompetitorMonitorAsyncResultSchema,
} from '../src/domains/competitor-monitor';
const job = {
  taskId: '5f14b965-a86e-45c9-bb40-28c83959040a',
  userId: 'fixture-owner',
  taskType: 'competitor-monitor',
  taskSubType: 'competitor',
  createdAt: '2026-10-03T01:00:00.000Z',
  expiresAt: '2026-10-10T01:00:00.000Z',
  countries: ['US', 'DE'],
};
describe('independent async competitor monitor contracts', () => {
  it('normalizes and deduplicates six countries, leaving default selection to the producer', () => {
    expect(
      triggerCompetitorMonitorAsyncRequestSchema.parse({
        countries: [' us ', 'DE', 'US', 'fr'],
      }),
    ).toEqual({ countries: ['US', 'DE', 'FR'] });
    expect(triggerCompetitorMonitorAsyncRequestSchema.parse({})).toEqual({});
  });
  it.each([
    { countries: [] },
    { countries: ['JP'] },
    { countries: ['US'], batchIndex: 1 },
  ])('rejects unsupported producer input %j', (raw) => {
    expect(
      triggerCompetitorMonitorAsyncRequestSchema.safeParse(raw).success,
    ).toBe(false);
  });
  it('has an explicit queue contract and cannot masquerade as the Legacy synchronous result', () => {
    const response = {
      success: true,
      errorCode: 0,
      data: {
        message: 'queued',
        queued: true,
        jobId: job.taskId,
        countries: job.countries,
      },
    };
    expect(
      triggerCompetitorMonitorAsyncResultSchema.safeParse(response).success,
    ).toBe(true);
    expect(
      competitorMonitorTriggerResultSchema.safeParse(response).success,
    ).toBe(false);
  });
  it('accepts the distinct canonical payload', () =>
    expect(competitorMonitorJobSchema.safeParse(job).success).toBe(true));
  it.each([
    { taskType: 'monitor', taskSubType: 'primary' },
    { countries: ['US', 'US'] },
    { countries: ['us'] },
    { createdAt: '2026-10-03T01:00:00Z' },
    { expiresAt: job.createdAt },
    { expiresAt: '2028-10-03T00:00:00.000Z' },
    { userId: 'unsafe\nowner' },
  ])('rejects changed or noncanonical immutable payload %j', (delta) =>
    expect(
      competitorMonitorJobSchema.safeParse({ ...job, ...delta }).success,
    ).toBe(false),
  );
});
