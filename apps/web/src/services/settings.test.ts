import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/http';
import { feishuCountryKey, SettingsApi } from './settings';

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
  revision: '11111111-1111-4111-8111-111111111111',
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

  it('accepts the committed disable 404 only after confirming the same row is disabled', async () => {
    const client = http();
    client.request
      .mockRejectedValueOnce(new ApiError('HTTP', '配置不存在', 404, 404))
      .mockResolvedValueOnce({
        success: true,
        data: [{ ...feishu, country: 'eu  ', enabled: 0 }],
      });
    await new SettingsApi(client).saveFeishuChange(
      'EU',
      { ...feishu, country: 'eu  ', webhookUrl: '***REDACTED***' },
      { enabled: false },
    );
    expect(client.request).toHaveBeenNthCalledWith(
      1,
      '/api/v1/feishu-configs/eu%20%20/toggle',
      expect.objectContaining({ method: 'PATCH', json: { enabled: false } }),
      expect.anything(),
    );
    expect(client.request).toHaveBeenNthCalledWith(
      2,
      '/api/v1/feishu-configs',
      expect.objectContaining({ signal: undefined }),
      expect.anything(),
    );
  });

  it('keeps a disable 404 when the row is gone or remains enabled', async () => {
    for (const rows of [[], [feishu]]) {
      const client = http();
      client.request
        .mockRejectedValueOnce(new ApiError('HTTP', '配置不存在', 404, 404))
        .mockResolvedValueOnce({ success: true, data: rows });
      await expect(
        new SettingsApi(client).saveFeishuChange(
          'EU',
          { ...feishu, webhookUrl: '***REDACTED***' },
          { enabled: false },
        ),
      ).rejects.toMatchObject({ status: 404 });
    }
  });

  it('never reconciles an enable 404 or unrelated disable failure', async () => {
    for (const [enabled, error] of [
      [true, new ApiError('HTTP', '配置不存在', 404, 404)],
      [false, new ApiError('HTTP', '未授权', 403, 403)],
    ] as const) {
      const client = http();
      client.request.mockRejectedValueOnce(error);
      await expect(
        new SettingsApi(client).saveFeishuChange(
          'EU',
          { ...feishu, webhookUrl: '***REDACTED***' },
          { enabled },
        ),
      ).rejects.toBe(error);
      expect(client.request).toHaveBeenCalledTimes(1);
    }
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

  it.each([
    'not-a-url',
    'http://open.feishu.cn/open-apis/bot/v2/hook/example',
    'https://user:password@open.feishu.cn/hook',
    'https://open.feishu.cn/hook#fragment',
  ])(
    'rejects an invalid webhook replacement before any request: %s',
    async (url) => {
      const client = http();
      await expect(
        new SettingsApi(client).saveFeishuChange('EU', feishu, {
          webhookUrl: url,
        }),
      ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
      expect(client.request).not.toHaveBeenCalled();
    },
  );

  it('rejects a webhook replacement when another admin changed the row', async () => {
    const client = http();
    client.request.mockResolvedValue({
      success: true,
      // Wall-clock timestamps may be identical when two writes are close.
      data: [{ ...feishu, revision: '22222222-2222-4222-8222-222222222222' }],
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
          expectedRevision: feishu.revision,
        },
      }),
      expect.anything(),
    );
  });

  it('matches imported country keys during webhook revision check', async () => {
    const imported = { ...feishu, country: 'eu  ' };
    const client = http();
    client.request
      .mockResolvedValueOnce({ success: true, data: [imported] })
      .mockResolvedValueOnce({ success: true, data: null });
    expect(feishuCountryKey(imported.country)).toBe('EU');
    await new SettingsApi(client).saveFeishuChange(
      'EU',
      { ...imported, webhookUrl: '***REDACTED***' },
      { webhookUrl: 'https://open.feishu.cn/new-hook' },
    );
    expect(client.request).toHaveBeenNthCalledWith(
      2,
      '/api/v1/feishu-configs',
      expect.objectContaining({
        method: 'POST',
        json: {
          country: 'eu  ',
          webhookUrl: 'https://open.feishu.cn/new-hook',
          enabled: true,
          expectedRevision: feishu.revision,
        },
      }),
      expect.anything(),
    );
  });

  it('marks a new Feishu row as create-only', async () => {
    const client = http();
    client.request
      .mockResolvedValueOnce({ success: true, data: [] })
      .mockResolvedValueOnce({ success: true, data: null });
    await new SettingsApi(client).saveFeishuChange('US', undefined, {
      webhookUrl: 'https://open.feishu.cn/new-hook',
    });
    expect(client.request).toHaveBeenNthCalledWith(
      2,
      '/api/v1/feishu-configs',
      expect.objectContaining({
        method: 'POST',
        json: {
          country: 'US',
          webhookUrl: 'https://open.feishu.cn/new-hook',
          enabled: false,
          expectedRevision: null,
        },
      }),
      expect.anything(),
    );
  });

  it('fails closed when an existing Neo row has no revision', async () => {
    const client = http();
    const oldRow = { ...feishu, revision: undefined };
    client.request.mockResolvedValue({ success: true, data: [oldRow] });
    await expect(
      new SettingsApi(client).saveFeishuChange(
        'EU',
        { ...oldRow, webhookUrl: '***REDACTED***' },
        { webhookUrl: 'https://open.feishu.cn/new-hook' },
      ),
    ).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it('reports an atomic server conflict after a matching preflight without retrying', async () => {
    const client = http();
    const draft = { webhookUrl: 'https://open.feishu.cn/new-hook' };
    client.request
      .mockResolvedValueOnce({ success: true, data: [feishu] })
      .mockRejectedValueOnce(
        new ApiError('HTTP', '配置已变更，请刷新后重试', 409, 409),
      );
    await expect(
      new SettingsApi(client).saveFeishuChange(
        'EU',
        { ...feishu, webhookUrl: '***REDACTED***' },
        draft,
      ),
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('输入已保留'),
    });
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it('rejects error windows outside the server contract', async () => {
    const client = http();
    await expect(new SettingsApi(client).errors(169)).rejects.toMatchObject({
      kind: 'INVALID_INPUT',
    });
    expect(client.request).not.toHaveBeenCalled();
  });
});
