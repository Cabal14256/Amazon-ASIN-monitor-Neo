import type { SpApiDisplayConfig } from '@asin-monitor/contracts';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../lib/http';
import {
  DEFAULT_MONITOR_CONCURRENCY_CAP,
  deniedSettingsError,
  isEmptySensitiveReplacement,
  isSupportedMonitorConcurrency,
  isSupportedScheduleMinutes,
  SCHEDULE_MINUTE_OPTIONS,
  SETTINGS_CONFIG_KEYS,
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

  it('rejects concurrency values the active Legacy loader would truncate, default, or cap', () => {
    expect(DEFAULT_MONITOR_CONCURRENCY_CAP).toBe(10);
    for (const value of ['1', '2', '9', '10'])
      expect(isSupportedMonitorConcurrency(value)).toBe(true);
    for (const value of ['', '0', '-1', '1.5', '11', 'Infinity', ' 2 '])
      expect(isSupportedMonitorConcurrency(value)).toBe(false);
  });

  it('blocks a blank edited credential because the environment may remain active', () => {
    expect(isEmptySensitiveReplacement('SP_API_US_LWA_CLIENT_SECRET', '')).toBe(
      true,
    );
    expect(isEmptySensitiveReplacement('SP_API_REFRESH_TOKEN', '   ')).toBe(
      true,
    );
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
