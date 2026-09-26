import { describe, expect, it, vi } from 'vitest';
import { clearAnalyticsCache, getOpsOverview, refreshAnalytics } from './ops';

const overview = {
  processRole: 'api',
  schedulerEnabled: false,
  workerRegisteredQueues: ['variant-check'],
  workerProcessorDetails: {},
  cache: {},
  analyticsCache: { prefixes: ['analytics:v1:'], lastClearedAt: null },
  riskControl: {},
  scheduler: {},
  analyticsAgg: {},
  queues: {
    monitor: { counts: { waiting: 2 }, isPaused: false, limiter: {} },
    competitor: { counts: { waiting: 0 }, isPaused: false, limiter: {} },
  },
};

describe('ops transport', () => {
  it('validates the overview and uses bounded reads', async () => {
    const request = vi.fn().mockResolvedValue({
      success: true,
      errorCode: 0,
      data: overview,
    });
    await expect(getOpsOverview({ request })).resolves.toEqual(overview);
    expect(request).toHaveBeenCalledWith(
      '/api/v1/ops/overview',
      expect.objectContaining({ timeoutMs: 120_000 }),
      expect.anything(),
    );
  });

  it('keeps actions on their documented endpoints and validates input', async () => {
    const request = vi.fn().mockResolvedValue({
      success: true,
      errorCode: 0,
      data: { prefixes: [], clearedAt: '2026-01-01T00:00:00.000Z' },
    });
    await clearAnalyticsCache({ request });
    expect(request.mock.calls[0][0]).toBe('/api/v1/ops/analytics/cache/clear');
    await expect(
      refreshAnalytics({ request }, { granularity: 'week' as never }),
    ).rejects.toMatchObject({
      kind: 'INVALID_INPUT',
    });
  });
});
