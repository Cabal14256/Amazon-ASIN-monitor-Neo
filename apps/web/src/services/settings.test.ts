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
      expect.objectContaining({ method: 'PUT', json: { configs: [{ configKey: config.configKey, configValue: 'new-secret' }] } }),
      expect.anything(),
    );
  });

  it('parses masked read-only configuration without exposing a value', async () => {
    const client = http();
    client.request.mockResolvedValue({ success: true, data: [config] });
    await expect(new SettingsApi(client).spApiConfigs()).resolves.toEqual([config]);
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

  it('rejects error windows outside the server contract', async () => {
    const client = http();
    await expect(new SettingsApi(client).errors(169)).rejects.toMatchObject({
      kind: 'INVALID_INPUT',
    });
    expect(client.request).not.toHaveBeenCalled();
  });
});
