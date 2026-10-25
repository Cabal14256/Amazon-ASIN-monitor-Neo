import { describe, expect, it, vi } from 'vitest';
import { deliverScheduledMonitorNotifications } from '../src/scheduled-monitor-notifications';

const job = {
  domain: 'primary',
  country: 'US',
  taskId: '00000000-0000-5000-8000-000000000001',
  jobId: 'scheduled-job',
} as any;
const run = {
  job,
  groups: [{ ordinal: 0, country: 'US', group: { id: 'g1', name: 'G1' } }],
} as any;

function fixture(result: unknown) {
  const ledger = {
    readGroupReceipt: vi.fn(async () => result),
    readNotification: vi.fn(async () => undefined),
    claimNotification: vi.fn(async () => 'new' as const),
    completeNotification: vi.fn(async () => undefined),
  };
  const notifications = {
    withCountryDelivery: vi.fn(async (_domain, _country, _summary, send) =>
      send(async () => ({ success: true, skipped: false })),
    ),
    withCompetitorCountryDelivery: vi.fn(),
  };
  return { ledger, notifications };
}

describe('scheduled monitor notification adapter', () => {
  it('claims only once the country delivery reaches its send callback', async () => {
    const f = fixture({
      isBroken: true,
      brokenASINs: [{ asin: 'B000000001', brand: 'Brand' }],
      brokenByType: { SP_API_ERROR: 0, NOT_FOUND: 0, NO_VARIANTS: 1 },
      groupSnapshot: { id: 'g1', country: 'US', name: 'G1' },
    });
    await deliverScheduledMonitorNotifications(
      run,
      new AbortController().signal,
      async () => undefined,
      {
        ledgerFor: () => f.ledger,
        notifications: f.notifications,
      },
    );
    expect(f.ledger.claimNotification).toHaveBeenCalledOnce();
    expect(f.ledger.completeNotification).toHaveBeenCalledWith(
      job,
      'US',
      true,
      expect.any(AbortSignal),
    );
  });

  it('keeps a claimed notification when the external ACK is uncertain', async () => {
    const f = fixture({
      isBroken: true,
      brokenASINs: [{ asin: 'B000000001' }],
      groupSnapshot: { id: 'g1', country: 'US', name: 'G1' },
    });
    f.notifications.withCountryDelivery.mockImplementationOnce(
      async (_domain, _country, _summary, send) =>
        send(async () => ({
          success: false,
          skipped: false,
          unconfirmed: true,
        })),
    );
    await deliverScheduledMonitorNotifications(
      run,
      new AbortController().signal,
      async () => undefined,
      {
        ledgerFor: () => f.ledger,
        notifications: f.notifications,
      },
    );
    expect(f.ledger.claimNotification).toHaveBeenCalledOnce();
    expect(f.ledger.completeNotification).not.toHaveBeenCalled();
  });

  it('does not claim when the frozen receipts contain no broken ASIN', async () => {
    const f = fixture({
      isBroken: false,
      brokenASINs: [],
      groupSnapshot: { id: 'g1', country: 'US', name: 'G1' },
    });
    await deliverScheduledMonitorNotifications(
      { ...run, job: { ...job, domain: 'competitor' } },
      new AbortController().signal,
      async () => undefined,
      {
        ledgerFor: () => f.ledger,
        notifications: f.notifications,
      },
    );
    expect(f.ledger.claimNotification).not.toHaveBeenCalled();
  });

  it('delivers a primary confirmation when all groups are healthy', async () => {
    const f = fixture({
      isBroken: false,
      brokenASINs: [],
      groupSnapshot: { id: 'g1', country: 'US', name: 'G1' },
    });
    await deliverScheduledMonitorNotifications(
      run,
      new AbortController().signal,
      async () => undefined,
      { ledgerFor: () => f.ledger, notifications: f.notifications },
    );
    expect(f.ledger.claimNotification).toHaveBeenCalledOnce();
    expect(f.ledger.completeNotification).toHaveBeenCalledWith(
      job,
      'US',
      true,
      expect.any(AbortSignal),
    );
  });

  it('does not notify a group or member whose frozen switch is disabled', async () => {
    const f = fixture({
      isBroken: true,
      brokenASINs: [{ asin: 'B000000001' }],
      groupSnapshot: {
        id: 'g1',
        country: 'US',
        name: 'G1',
        feishuNotifyEnabled: 0,
        children: [{ asin: 'B000000001', feishuNotifyEnabled: 1 }],
      },
    });
    await deliverScheduledMonitorNotifications(
      run,
      new AbortController().signal,
      async () => undefined,
      { ledgerFor: () => f.ledger, notifications: f.notifications },
    );
    expect(f.ledger.claimNotification).not.toHaveBeenCalled();
  });

  it('does not rebuild or resend an already completed notification', async () => {
    const f = fixture({
      isBroken: true,
      brokenASINs: [{ asin: 'B000000001' }],
      groupSnapshot: { id: 'g1', country: 'US', name: 'G1' },
    });
    f.ledger.readNotification.mockResolvedValue('sent');
    await deliverScheduledMonitorNotifications(
      run,
      new AbortController().signal,
      async () => undefined,
      { ledgerFor: () => f.ledger, notifications: f.notifications },
    );
    expect(f.ledger.claimNotification).not.toHaveBeenCalled();
    expect(f.notifications.withCountryDelivery).not.toHaveBeenCalled();
  });

  it('bounds legal large summaries and marks omitted notification details', async () => {
    const f = fixture({
      isBroken: true,
      brokenASINs: Array.from({ length: 10_008 }, (_, index) => ({
        asin: '%'.repeat(20),
      })),
      groupSnapshot: {
        id: 'g1',
        country: 'US',
        name: 'G1',
        feishuNotifyEnabled: 1,
        children: [],
      },
    });
    let delivered: any;
    f.notifications.withCountryDelivery.mockImplementationOnce(
      async (_domain, _country, summary, send) => {
        delivered = summary;
        return send(async () => ({ success: true, skipped: false }));
      },
    );
    await expect(
      deliverScheduledMonitorNotifications(
        run,
        new AbortController().signal,
        async () => undefined,
        { ledgerFor: () => f.ledger, notifications: f.notifications },
      ),
    ).resolves.toBeUndefined();
    expect(delivered.notificationTruncated).toBe(true);
    expect(delivered.brokenASINs.length).toBeLessThan(10_000);
    expect(
      delivered.brokenGroupNames.length +
        delivered.brokenGroupDetails.length +
        delivered.brokenASINs.length,
    ).toBeLessThanOrEqual(10_000);
    expect(f.ledger.completeNotification).toHaveBeenCalledOnce();
  });
});
