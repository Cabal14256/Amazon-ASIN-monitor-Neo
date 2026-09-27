import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { SettingsApi } from './settings';

const config = {
  configKey: 'SP_API_US_LWA_CLIENT_SECRET',
  configValue: '',
  displayValue: 'abcd****wxyz',
  hasValue: true,
  description: 'US secret',
  id: 1,
  createTime: null,
  updateTime: null,
};
const feishu = {
  id: 7,
  country: 'EU',
  webhookUrl: 'https://open.feishu.cn/open-apis/bot/v2/hook/private-key',
  enabled: 1 as const,
  createTime: null,
  updateTime: '2026-09-26T12:00:00.000Z',
};
function http() {
  return { request: vi.fn() };
}

describe('SettingsApi', () => {
  it('validates and sends only the requested SP-API changes', async () => {
    const client = http();
    client.request.mockResolvedValue({ success: true, data: [] });
    await new SettingsApi(client).updateSpApiConfigs({
      configs: [{ configKey: config.configKey, configValue: 'new-secret' }],
    });
    expect(client.request).toHaveBeenCalledWith(
      '/api/v1/sp-api-configs',
      expect.objectContaining({
        method: 'PUT',
        json: {
          configs: [{ configKey: config.configKey, configValue: 'new-secret' }],
        },
      }),
      expect.anything(),
    );
  });

  it('removes raw and partially masked credentials before query caching', async () => {
    const client = http();
    client.request.mockResolvedValue({
      success: true,
      data: [
        { ...config, configValue: 'raw-private-secret' },
        {
          ...config,
          configKey: 'MONITOR_US_SCHEDULE_MINUTES',
          configValue: '30',
          displayValue: '30',
        },
      ],
    });
    await expect(new SettingsApi(client).spApiConfigs()).resolves.toEqual([
      { ...config, displayValue: '' },
      {
        ...config,
        configKey: 'MONITOR_US_SCHEDULE_MINUTES',
        configValue: '30',
        displayValue: '30',
      },
    ]);
  });

  it('removes raw Feishu webhooks before query caching', async () => {
    const client = http();
    client.request.mockResolvedValue({ success: true, data: [feishu] });
    const rows = await new SettingsApi(client).feishuConfigs();
    expect(rows[0]).toMatchObject({
      country: 'EU',
      webhookUrl: '***REDACTED***',
      enabled: 1,
    });
    expect(JSON.stringify(rows)).not.toContain('private-key');
  });

  it('keeps only redacted values in the actual Query cache', async () => {
    const client = http();
    client.request.mockImplementation(async (path: string) =>
      path === '/api/v1/sp-api-configs'
        ? {
            success: true,
            data: [{ ...config, configValue: 'raw-private-secret' }],
          }
        : { success: true, data: [feishu] },
    );
    const api = new SettingsApi(client);
    const cache = new QueryClient();
    await cache.fetchQuery({
      queryKey: ['settings', 'sp-api'],
      queryFn: () => api.spApiConfigs(),
    });
    await cache.fetchQuery({
      queryKey: ['settings', 'feishu'],
      queryFn: () => api.feishuConfigs(),
    });
    const snapshot = JSON.stringify(
      cache
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
    );
    expect(snapshot).not.toContain('raw-private-secret');
    expect(snapshot).not.toContain('private-key');
    cache.clear();
  });

  it('encodes Feishu country and keeps toggle values boolean', async () => {
    const client = http();
    client.request.mockResolvedValue({ success: true, data: null });
    await new SettingsApi(client).toggleFeishu('EU West', { enabled: false });
    expect(client.request).toHaveBeenCalledWith(
      '/api/v1/feishu-configs/EU%20West/toggle',
      expect.objectContaining({ method: 'PATCH', json: { enabled: false } }),
      expect.anything(),
    );
  });

  it('toggles an existing Feishu row without resending the old webhook', async () => {
    const client = http();
    client.request.mockResolvedValue({ success: true, data: null });
    await new SettingsApi(client).saveFeishuChange(
      'EU',
      { ...feishu, webhookUrl: '***REDACTED***' },
      { enabled: false },
    );
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledWith(
      '/api/v1/feishu-configs/EU/toggle',
      expect.objectContaining({ method: 'PATCH', json: { enabled: false } }),
      expect.anything(),
    );
  });

  it('does not enable a Feishu row that has no webhook', async () => {
    const client = http();
    await expect(
      new SettingsApi(client).saveFeishuChange(
        'EU',
        { ...feishu, webhookUrl: '' },
        { enabled: true },
      ),
    ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
    expect(client.request).not.toHaveBeenCalled();
  });

  it('rejects a webhook replacement when another admin changed the row', async () => {
    const client = http();
    client.request.mockResolvedValue({
      success: true,
      data: [{ ...feishu, updateTime: '2026-09-26T12:00:01.000Z' }],
    });
    await expect(
      new SettingsApi(client).saveFeishuChange(
        'EU',
        { ...feishu, webhookUrl: '***REDACTED***' },
        { webhookUrl: 'https://open.feishu.cn/new-hook' },
      ),
    ).rejects.toMatchObject({ kind: 'BUSINESS', status: 409 });
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it('uses a fresh row state when replacing a webhook', async () => {
    const client = http();
    client.request
      .mockResolvedValueOnce({ success: true, data: [feishu] })
      .mockResolvedValueOnce({ success: true, data: null });
    await new SettingsApi(client).saveFeishuChange(
      'EU',
      { ...feishu, webhookUrl: '***REDACTED***' },
      { webhookUrl: 'https://open.feishu.cn/new-hook' },
    );
    expect(client.request).toHaveBeenNthCalledWith(
      2,
      '/api/v1/feishu-configs',
      expect.objectContaining({
        method: 'POST',
        json: {
          country: 'EU',
          webhookUrl: 'https://open.feishu.cn/new-hook',
          enabled: true,
        },
      }),
      expect.anything(),
    );
  });

  it('rejects error windows outside the server contract', async () => {
    const client = http();
    await expect(new SettingsApi(client).errors(169)).rejects.toMatchObject({
      kind: 'INVALID_INPUT',
    });
    expect(client.request).not.toHaveBeenCalled();
  });
});
