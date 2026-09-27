import type { SpApiDisplayConfig } from '@asin-monitor/contracts';

export const SETTINGS_CONFIG_GROUPS = [
  {
    title: 'US 区域 LWA',
    keys: [
      'SP_API_US_LWA_CLIENT_ID',
      'SP_API_US_LWA_CLIENT_SECRET',
      'SP_API_US_REFRESH_TOKEN',
    ],
  },
  {
    title: 'EU 区域 LWA',
    keys: [
      'SP_API_EU_LWA_CLIENT_ID',
      'SP_API_EU_LWA_CLIENT_SECRET',
      'SP_API_EU_REFRESH_TOKEN',
    ],
  },
  {
    title: '通用 LWA 备用凭据',
    keys: [
      'SP_API_LWA_CLIENT_ID',
      'SP_API_LWA_CLIENT_SECRET',
      'SP_API_REFRESH_TOKEN',
    ],
  },
  {
    title: 'AWS 与签名',
    keys: [
      'SP_API_ACCESS_KEY_ID',
      'SP_API_SECRET_ACCESS_KEY',
      'SP_API_ROLE_ARN',
      'SP_API_USE_AWS_SIGNATURE',
    ],
  },
  {
    title: '监控与备用来源',
    keys: [
      'MONITOR_MAX_CONCURRENT_GROUP_CHECKS',
      'MONITOR_US_SCHEDULE_MINUTES',
      'MONITOR_EU_SCHEDULE_MINUTES',
      'COMPETITOR_MONITOR_ENABLED',
      'ENABLE_HTML_SCRAPER_FALLBACK',
      'ENABLE_LEGACY_CLIENT_FALLBACK',
    ],
  },
] as const;

export const SETTINGS_CONFIG_KEYS = SETTINGS_CONFIG_GROUPS.flatMap(
  (group) => group.keys,
);

export function isSensitiveConfigKey(key: string) {
  return /SECRET|TOKEN|KEY/i.test(key);
}

export function visibleConfigValue(
  row: SpApiDisplayConfig,
  draft: string | undefined,
  canWrite: boolean,
) {
  if (isSensitiveConfigKey(row.configKey)) return canWrite ? draft ?? '' : '';
  return canWrite ? draft ?? row.configValue : row.configValue;
}
