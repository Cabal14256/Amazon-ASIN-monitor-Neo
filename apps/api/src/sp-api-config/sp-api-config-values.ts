import type { SpApiDisplayConfig } from '@asin-monitor/contracts';

const descriptions = {
  SP_API_US_LWA_CLIENT_ID: 'US 区域 LWA Client ID',
  SP_API_US_LWA_CLIENT_SECRET: 'US 区域 LWA Client Secret',
  SP_API_US_REFRESH_TOKEN: 'US 区域 Refresh Token',
  SP_API_EU_LWA_CLIENT_ID: 'EU 区域 LWA Client ID',
  SP_API_EU_LWA_CLIENT_SECRET: 'EU 区域 LWA Client Secret',
  SP_API_EU_REFRESH_TOKEN: 'EU 区域 Refresh Token',
  SP_API_LWA_CLIENT_ID: 'LWA Client ID（通用）',
  SP_API_LWA_CLIENT_SECRET: 'LWA Client Secret（通用）',
  SP_API_REFRESH_TOKEN: 'Refresh Token（通用）',
  SP_API_ACCESS_KEY_ID: 'AWS Access Key ID（US+EU共用）',
  SP_API_SECRET_ACCESS_KEY: 'AWS Secret Access Key（US+EU共用）',
  SP_API_ROLE_ARN: 'AWS IAM Role ARN（US+EU共用）',
  MONITOR_MAX_CONCURRENT_GROUP_CHECKS: '每次并发检查的变体组数量',
  MONITOR_US_SCHEDULE_MINUTES: 'US 区域定时监控间隔（分钟）',
  MONITOR_EU_SCHEDULE_MINUTES: 'EU 区域定时监控间隔（分钟）',
  COMPETITOR_MONITOR_ENABLED: '竞品监控开关',
  SP_API_USE_AWS_SIGNATURE: '是否启用AWS签名（简化模式：关闭，标准模式：开启）',
  ENABLE_HTML_SCRAPER_FALLBACK: '是否启用HTML抓取兜底（SP-API失败时使用）',
  ENABLE_LEGACY_CLIENT_FALLBACK: '是否启用旧客户端备用（SP-API失败时使用）',
} as const;
export const SP_API_DISPLAY_KEYS = Object.freeze(Object.keys(descriptions));
export const SP_API_MANAGED_KEYS = Object.freeze([
  ...SP_API_DISPLAY_KEYS,
  'SP_API_SESSION_TOKEN',
  ...(['US', 'EU'] as const).flatMap((region) =>
    ['ACCESS_KEY_ID', 'SECRET_ACCESS_KEY', 'SESSION_TOKEN'].map(
      (suffix) => `SP_API_${region}_${suffix}`,
    ),
  ),
]);
const managed = new Set(SP_API_MANAGED_KEYS);
const defaults: Readonly<Record<string, string>> = {
  COMPETITOR_MONITOR_ENABLED: 'true',
  MONITOR_US_SCHEDULE_MINUTES: '30',
  MONITOR_EU_SCHEDULE_MINUTES: '60',
};
export interface SpApiConfigValueRecord {
  id: number;
  configKey: string;
  configValue: string | null;
  description: string | null;
  createTime: Date | null;
  updateTime: Date | null;
}
export interface SpApiConfigChange {
  configKey: string;
  configValue: string;
  description: string;
}
export class SpApiConfigInputError extends Error {
  constructor() {
    super('SP-API INVALID_INPUT');
  }
}
export function isManagedSpApiKey(key: string) {
  return managed.has(key);
}
export function isSensitiveSpApiKey(key: string) {
  return /SECRET|TOKEN|KEY/i.test(key);
}
function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return String(value).trim();
  throw new SpApiConfigInputError();
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function normalizeSpApiConfigUpdates(
  input: unknown,
): SpApiConfigChange[] {
  if (
    !record(input) ||
    Object.keys(input).some((key) => key !== 'configs') ||
    !Array.isArray(input.configs) ||
    input.configs.length < 1 ||
    input.configs.length > SP_API_MANAGED_KEYS.length
  )
    throw new SpApiConfigInputError();
  const seen = new Set<string>();
  let bytes = 0;
  return input.configs.map((item: unknown) => {
    if (
      !record(item) ||
      !Object.hasOwn(item, 'configValue') ||
      Object.keys(item).some(
        (key) => !['configKey', 'configValue', 'description'].includes(key),
      ) ||
      typeof item.configKey !== 'string'
    )
      throw new SpApiConfigInputError();
    const configKey = item.configKey.trim().toUpperCase();
    if (!managed.has(configKey) || seen.has(configKey))
      throw new SpApiConfigInputError();
    seen.add(configKey);
    const configValue = text(item.configValue);
    if (
      item.description !== undefined &&
      item.description !== null &&
      typeof item.description !== 'string'
    )
      throw new SpApiConfigInputError();
    const description = text(item.description);
    if (
      configValue.length > 4096 ||
      /[\x00-\x1f\x7f]/.test(configValue) ||
      description.length > 255 ||
      /[\x00-\x1f\x7f]/.test(description)
    )
      throw new SpApiConfigInputError();
    bytes += Buffer.byteLength(configKey + configValue + description, 'utf8');
    if (bytes > 65_536) throw new SpApiConfigInputError();
    return { configKey, configValue, description };
  });
}
export function displaySpApiConfigs(
  rows: readonly SpApiConfigValueRecord[],
  env: Readonly<Record<string, unknown>>,
  revealSensitive: boolean,
): SpApiDisplayConfig[] {
  if (rows.length > 200) throw new Error('SP-API CONFIG_DATA_INVALID');
  const byKey = new Map(rows.map((row) => [row.configKey.toUpperCase(), row]));
  return SP_API_DISPLAY_KEYS.map((key) => {
    const row = byKey.get(key);
    const stored = row?.configValue;
    // Display has a different empty-value rule from credential resolution:
    // explicitly stored empty text stays empty instead of falling through ENV.
    const raw =
      stored !== null && stored !== undefined
        ? stored
        : env[key] === undefined || env[key] === ''
        ? defaults[key] ?? ''
        : env[key];
    const value = raw === null || raw === undefined ? '' : String(raw);
    if (
      value.length > 4096 ||
      (row && (!Number.isSafeInteger(row.id) || row.id < 1))
    )
      throw new Error('SP-API CONFIG_DATA_INVALID');
    const sensitive = isSensitiveSpApiKey(key);
    const displayValue =
      sensitive && value
        ? value.length > 8
          ? `${value.slice(0, 4)}****${value.slice(-4)}`
          : '****'
        : value;
    return {
      id: row?.id ?? null,
      configKey: key,
      configValue: sensitive && !revealSensitive ? '' : value,
      displayValue,
      hasValue: Boolean(value),
      description:
        row?.description || descriptions[key as keyof typeof descriptions],
      createTime: row?.createTime?.toISOString() ?? null,
      updateTime: row?.updateTime?.toISOString() ?? null,
    };
  });
}
