import { describe, expect, it, vi } from 'vitest';
import type { CountryNotificationResult } from '../src/ports';
import { FeishuNotifications } from '../src/service';
const data = {
  totalGroups: 1,
  brokenGroups: 1,
  brokenGroupNames: ['group'],
  brokenASINs: [{ asin: 'B000000001', groupName: 'group' }],
};
function fixture() {
  const read = vi.fn(
    async () =>
      ({ webhookUrl: 'https://example.invalid/isolated-hook' } as
        | { webhookUrl: string }
        | undefined),
  );
  const send = vi.fn(async () => ({ statusCode: 200, code: 0 }));
  const service = new FeishuNotifications({
    source: { read },
    transport: { send, close() {} },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
  const guard = vi.fn(async () => {});
  return { read, send, service, guard };
}
describe('competitor monitor prepared delivery', () => {
  it('reads enabled competitor region configuration before durable claim and rechecks before POST', async () => {
    const f = fixture(),
      trace: string[] = [];
    f.guard.mockImplementation(async () => {
      trace.push('guard');
    });
    f.read.mockImplementation(async () => {
      trace.push('config');
      return { webhookUrl: 'https://example.invalid/hook' };
    });
    f.send.mockImplementation(async () => {
      trace.push('post');
      return { statusCode: 200, code: 0 };
    });
    const result = await f.service.withCompetitorCountryDelivery(
      'DE',
      data,
      async (send) => {
        trace.push('claim');
        return send();
      },
      f.guard,
    );
    expect(result).toEqual({ success: true, skipped: false });
    expect(f.read).toHaveBeenCalledWith(
      'competitor',
      'EU',
      expect.any(AbortSignal),
    );
    expect(trace).toEqual([
      'guard',
      'config',
      'claim',
      'config',
      'guard',
      'post',
    ]);
    f.service.close();
  });
  it('does not claim when configuration is disabled or the current query fails', async () => {
    const f = fixture(),
      claim = vi.fn();
    f.read.mockResolvedValueOnce(undefined);
    expect(
      await f.service.withCompetitorCountryDelivery('US', data, claim, f.guard),
    ).toBeUndefined();
    expect(claim).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    f.read.mockRejectedValueOnce(new Error('fixture-private-config-query'));
    await expect(
      f.service.withCompetitorCountryDelivery('US', data, claim, f.guard),
    ).rejects.toThrow('fixture-private-config-query');
    expect(claim).not.toHaveBeenCalled();
    f.service.close();
  });
  it('does not POST after authority was revoked between claim and fresh configuration read', async () => {
    const f = fixture();
    f.guard
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('REVOKED'));
    const claim = vi.fn(
      async (send: () => Promise<CountryNotificationResult>) => send(),
    );
    await expect(
      f.service.withCompetitorCountryDelivery('US', data, claim, f.guard),
    ).rejects.toThrow('REVOKED');
    expect(claim).toHaveBeenCalledOnce();
    expect(f.send).not.toHaveBeenCalled();
    f.service.close();
  });
  it('reserves the same admission slots as primary before a competitor claim', async () => {
    const f = fixture();
    let finish!: () => void;
    const barrier = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const primary = Array.from({ length: 4 }, () =>
      f.service.withCountryDelivery('primary', 'US', {}, async () => barrier),
    );
    const claim = vi.fn();
    await expect(
      f.service.withCompetitorCountryDelivery('US', data, claim, f.guard),
    ).rejects.toMatchObject({ reason: 'capacity' });
    expect(claim).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
    finish();
    await Promise.all(primary);
    f.service.close();
  });
  it('checks current control again before each explicit 11232 retry', async () => {
    const f = fixture();
    f.send.mockResolvedValueOnce({ statusCode: 200, code: 11232 });
    f.guard
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('REVOKED'));
    const service = new FeishuNotifications({
      source: { read: f.read },
      transport: { send: f.send, close() {} },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      delay: async () => {},
      random: () => 0,
    });
    await expect(
      service.withCompetitorCountryDelivery(
        'US',
        data,
        async (send) => send(),
        f.guard,
      ),
    ).rejects.toThrow('REVOKED');
    expect(f.send).toHaveBeenCalledOnce();
    service.close();
    f.service.close();
  });
  it.each([
    'not-a-url',
    'http://example.invalid/hook',
    'https://secret@example.invalid/hook',
  ])('does not claim invalid current webhook %s', async (webhookUrl) => {
    const f = fixture();
    f.read.mockResolvedValue({ webhookUrl });
    const claim = vi.fn();
    await expect(
      f.service.withCompetitorCountryDelivery('US', data, claim, f.guard),
    ).rejects.toMatchObject({ reason: 'invalid-config' });
    expect(claim).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    f.service.close();
  });
  it('distinguishes an attempted POST with unknown acknowledgement from a definite rejection', async () => {
    const f = fixture();
    f.send.mockRejectedValueOnce(new Error('isolated-response-ack-lost'));
    expect(
      await f.service.withCompetitorCountryDelivery(
        'US',
        data,
        (send) => send(),
        f.guard,
      ),
    ).toMatchObject({ success: false, skipped: false, unconfirmed: true });
    expect(f.send).toHaveBeenCalledOnce();
    f.send.mockResolvedValueOnce({ statusCode: 200, code: 1001 });
    const denied = await f.service.withCompetitorCountryDelivery(
      'US',
      data,
      (send) => send(),
      f.guard,
    );
    expect(denied).toMatchObject({ success: false, errorCode: 1001 });
    expect(denied).not.toHaveProperty('unconfirmed');
    f.service.close();
  });
});
