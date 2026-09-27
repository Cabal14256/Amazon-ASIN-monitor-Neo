import type { SpApiDisplayConfig } from '@asin-monitor/contracts';
import { describe, expect, it } from 'vitest';
import { SETTINGS_CONFIG_KEYS, visibleConfigValue } from './settings-model';

const secretRow: SpApiDisplayConfig = {
  id: 1,
  configKey: 'SP_API_US_LWA_CLIENT_SECRET',
  configValue: 'server-raw-secret',
  displayValue: 'serv****cret',
  hasValue: true,
  description: 'US secret',
  createTime: null,
  updateTime: null,
};

describe('settings credential presentation', () => {
  it('covers every displayed SP-API key including shared LWA fallbacks', () => {
    expect(SETTINGS_CONFIG_KEYS).toHaveLength(19);
    expect(new Set(SETTINGS_CONFIG_KEYS).size).toBe(19);
    expect(SETTINGS_CONFIG_KEYS).toEqual(
      expect.arrayContaining([
        'SP_API_LWA_CLIENT_ID',
        'SP_API_LWA_CLIENT_SECRET',
        'SP_API_REFRESH_TOKEN',
      ]),
    );
  });

  it('never renders a server secret or an entered replacement after permission loss', () => {
    expect(visibleConfigValue(secretRow, undefined, true)).toBe('');
    expect(visibleConfigValue(secretRow, 'typed-replacement', true)).toBe(
      'typed-replacement',
    );
    expect(visibleConfigValue(secretRow, 'typed-replacement', false)).toBe('');
  });
});
