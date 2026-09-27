import type { FeishuConfig, SpApiDisplayConfig } from '@asin-monitor/contracts';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../lib/http';
import { SettingsApi } from '../../services/settings';
import {
  deniedSettingsError,
  isEmptySensitiveReplacement,
  isEnabledBooleanConfig,
  isSupportedMonitorConcurrency,
  isSupportedScheduleMinutes,
  SCHEDULE_MINUTE_OPTIONS,
  SETTINGS_CONFIG_KEYS,
  updateFeishuEdit,
  visibleConfigValue,
} from './settings-model';

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

  it('only offers monitor intervals supported by the Legacy scheduler', () => {
    expect(SCHEDULE_MINUTE_OPTIONS).toEqual(['15', '30', '60']);
    for (const value of SCHEDULE_MINUTE_OPTIONS)
      expect(isSupportedScheduleMinutes(value)).toBe(true);
    for (const value of ['', '0', '25', '90', '15.5'])
      expect(isSupportedScheduleMinutes(value)).toBe(false);
  });

  it('accepts positive integer concurrency values above the default deployment cap', () => {
    for (const value of ['1', '2', '9', '10', '15', '20', '500'])
      expect(isSupportedMonitorConcurrency(value)).toBe(true);
    for (const value of [
      '',
      '0',
      '-1',
      '1.5',
      '01',
      'Infinity',
      ' 2 ',
      '9007199254740992',
    ])
      expect(isSupportedMonitorConcurrency(value)).toBe(false);
  });

  it('only normalizes the competitor flag as its runtime does', () => {
    for (const value of ['true', 'TRUE', ' true ', '1', ' 1 '])
      expect(isEnabledBooleanConfig('COMPETITOR_MONITOR_ENABLED', value)).toBe(
        true,
      );
    for (const value of ['false', ' FALSE ', '0', '', 'invalid'])
      expect(isEnabledBooleanConfig('COMPETITOR_MONITOR_ENABLED', value)).toBe(
        false,
      );
    for (const key of [
      'SP_API_USE_AWS_SIGNATURE',
      'ENABLE_HTML_SCRAPER_FALLBACK',
      'ENABLE_LEGACY_CLIENT_FALLBACK',
    ]) {
      expect(isEnabledBooleanConfig(key, 'true')).toBe(true);
      expect(isEnabledBooleanConfig(key, '1')).toBe(true);
      expect(isEnabledBooleanConfig(key, 'TRUE')).toBe(false);
      expect(isEnabledBooleanConfig(key, ' true ')).toBe(false);
    }
  });

  it('keeps the first Feishu revision and rejects a stale webhook after background refetch', async () => {
    const original: FeishuConfig = {
      id: 7,
      country: 'EU',
      webhookUrl: '***REDACTED***',
      enabled: 1,
      createTime: null,
      updateTime: '2026-09-26T12:00:00.000Z',
    };
    const first = updateFeishuEdit(undefined, original, {
      webhookUrl: 'https://open.feishu.cn/new-hook',
    });
    const refreshed = { ...original, updateTime: '2026-09-26T12:00:01.000Z' };
    const second = updateFeishuEdit(first, refreshed, { enabled: false });
    expect(second.original).toBe(original);
    expect(second.draft).toEqual({
      webhookUrl: 'https://open.feishu.cn/new-hook',
      enabled: false,
    });
    const client = {
      request: vi.fn().mockResolvedValue({ success: true, data: [refreshed] }),
    };
    await expect(
      new SettingsApi(client).saveFeishuChange(
        'EU',
        second.original,
        second.draft,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(client.request).toHaveBeenCalledTimes(1);
  });

  it('blocks a blank edited credential because the environment may remain active', () => {
    expect(isEmptySensitiveReplacement('SP_API_US_LWA_CLIENT_SECRET', '')).toBe(
      true,
    );
    expect(isEmptySensitiveReplacement('SP_API_REFRESH_TOKEN', '   ')).toBe(
      true,
    );
    for (const key of [
      'SP_API_US_LWA_CLIENT_ID',
      'SP_API_EU_LWA_CLIENT_ID',
      'SP_API_LWA_CLIENT_ID',
      'SP_API_ROLE_ARN',
    ]) {
      expect(isEmptySensitiveReplacement(key, ' ')).toBe(true);
      expect(isEmptySensitiveReplacement(key, 'replacement-id')).toBe(false);
    }
    expect(
      isEmptySensitiveReplacement('SP_API_US_LWA_CLIENT_SECRET', 'new-value'),
    ).toBe(false);
    expect(isEmptySensitiveReplacement('MONITOR_US_SCHEDULE_MINUTES', '')).toBe(
      false,
    );
  });

  it('detects a 403 from either status query without treating other failures as permission loss', () => {
    const denied = new ApiError('HTTP', '禁止访问', 403, 403);
    const failure = new ApiError('HTTP', '上游异常', 500, 500);
    expect(deniedSettingsError(denied, null)).toBe(denied);
    expect(deniedSettingsError(failure, denied)).toBe(denied);
    expect(deniedSettingsError(failure, null)).toBeUndefined();
  });
});
