import {
  toggleFeishuConfigRequestSchema,
  upsertFeishuConfigRequestSchema,
} from '@asin-monitor/contracts';

export class FeishuConfigurationError extends Error {
  constructor(readonly reason: 'input' | 'result' | 'capacity') {
    super('Feishu configuration operation could not be completed');
  }
}
function invalid(): never {
  throw new FeishuConfigurationError('input');
}
function boundedText(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.includes('\0') ||
    [...value].length > maximum
  )
    return invalid();
  return value;
}
export const feishuCountry = (value: unknown): string => boundedText(value, 10);

/** Legacy maps only these exact uppercase country codes to the EU region. */
export function feishuRegion(country: string): string {
  return ['UK', 'DE', 'FR', 'IT', 'ES'].includes(country) ? 'EU' : country;
}
export interface FeishuConfigurationChange {
  country: string;
  webhookUrl: string;
  enabled: boolean;
}
export function feishuConfigurationChange(
  raw: unknown,
): FeishuConfigurationChange {
  const result = upsertFeishuConfigRequestSchema.safeParse(raw);
  if (!result.success) return invalid();
  return {
    country: feishuCountry(result.data.country),
    webhookUrl: boundedText(result.data.webhookUrl, 500),
    enabled:
      result.data.enabled === undefined ? true : Boolean(result.data.enabled),
  };
}
export function feishuEnabled(raw: unknown): boolean {
  const result = toggleFeishuConfigRequestSchema.safeParse(raw);
  return result.success ? Boolean(result.data.enabled) : invalid();
}
export interface FeishuConfigurationRow {
  id: number;
  country: string;
  webhookUrl: string;
  enabled: boolean | null;
  createTime: Date | null;
  updateTime: Date | null;
}
export function validateFeishuRow(
  row: FeishuConfigurationRow,
): FeishuConfigurationRow {
  if (
    !Number.isSafeInteger(row.id) ||
    row.id < 1 ||
    typeof row.country !== 'string' ||
    [...row.country].length > 10 ||
    typeof row.webhookUrl !== 'string' ||
    [...row.webhookUrl].length > 500 ||
    (row.enabled !== null && typeof row.enabled !== 'boolean') ||
    [row.createTime, row.updateTime].some(
      (value) =>
        value !== null &&
        (!(value instanceof Date) || !Number.isFinite(value.getTime())),
    )
  )
    throw new FeishuConfigurationError('result');
  return row;
}
/** Keep Legacy camel/list/write and snake/detail/toggle response shapes. */
export function displayFeishuConfiguration(
  row: FeishuConfigurationRow,
  shape: 'camel' | 'snake',
  revealWebhook: boolean,
) {
  validateFeishuRow(row);
  const webhook =
    revealWebhook || !row.webhookUrl ? row.webhookUrl : '***REDACTED***';
  const common = {
    id: row.id,
    country: row.country,
    enabled:
      row.enabled === null ? null : row.enabled ? (1 as const) : (0 as const),
  };
  return shape === 'camel'
    ? {
        ...common,
        webhookUrl: webhook,
        createTime: row.createTime?.toISOString() ?? null,
        updateTime: row.updateTime?.toISOString() ?? null,
      }
    : {
        ...common,
        webhook_url: webhook,
        create_time: row.createTime?.toISOString() ?? null,
        update_time: row.updateTime?.toISOString() ?? null,
      };
}
