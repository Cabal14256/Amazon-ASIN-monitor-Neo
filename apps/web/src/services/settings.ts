import {
  errorStatsResultSchema,
  feishuConfigListResultSchema,
  feishuConfigResultSchema,
  rateLimiterStatusResultSchema,
  spApiDisplayConfigListResultSchema,
  toggleFeishuConfigRequestSchema,
  updateSpApiConfigsRequestSchema,
  updateSpApiConfigsResultSchema,
  type FeishuConfig,
  type SpApiDisplayConfig,
  type ToggleFeishuConfigRequest,
  type UpdateSpApiConfigsRequest,
} from '@asin-monitor/contracts';
import { ApiError, type HttpClient } from '../lib/http';

const CONFIG = '/api/v1/sp-api-configs';
const FEISHU = '/api/v1/feishu-configs';
const READ_OPTIONS = {
  timeoutMs: 60_000,
  maxResponseBytes: 8 * 1024 * 1024,
} as const;
const SENSITIVE_CONFIG_KEY = /SECRET|TOKEN|KEY/i;

/** API writers may read raw credentials; the page only needs presence and edits. */
function safeConfigList(rows: SpApiDisplayConfig[]) {
  return rows.map((row) =>
    SENSITIVE_CONFIG_KEY.test(row.configKey)
      ? { ...row, configValue: '', displayValue: '' }
      : row,
  );
}

function safeFeishuList(rows: FeishuConfig[]) {
  return rows.map((row) => {
    const marker = row.webhookUrl || row.webhook_url ? '***REDACTED***' : '';
    return { ...row, webhookUrl: marker, webhook_url: marker };
  });
}

export interface FeishuDraft {
  webhookUrl?: string;
  enabled?: boolean;
}

function feishuRevision(row: FeishuConfig | undefined) {
  return row
    ? JSON.stringify([
        row.id,
        row.updateTime ?? row.update_time,
        row.enabled,
        Boolean(row.webhookUrl || row.webhook_url),
      ])
    : null;
}

function data<T>(
  response: { success?: boolean; data?: T },
  message: string,
): T {
  if (response.success !== true || response.data === undefined)
    throw new ApiError('INVALID_RESPONSE', message);
  return response.data;
}

function checked<T>(
  schema: {
    safeParse(value: unknown): { success: true; data: T } | { success: false };
  },
  value: unknown,
  message: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError('INVALID_INPUT', message);
  return parsed.data;
}

export class SettingsApi {
  constructor(private readonly http: Pick<HttpClient, 'request'>) {}

  private async spApiConfigsRaw(signal?: AbortSignal) {
    const response = await this.http.request(
      CONFIG,
      { signal, ...READ_OPTIONS },
      spApiDisplayConfigListResultSchema,
    );
    return data(response, 'SP-API 配置响应缺少数据');
  }

  async spApiConfigs(signal?: AbortSignal) {
    return safeConfigList(await this.spApiConfigsRaw(signal));
  }

  async updateSpApiConfigs(
    input: UpdateSpApiConfigsRequest,
    signal?: AbortSignal,
  ) {
    const body = checked(
      updateSpApiConfigsRequestSchema,
      input,
      'SP-API 配置参数无效',
    );
    const response = await this.http.request(
      CONFIG,
      { method: 'PUT', json: body, signal, ...READ_OPTIONS },
      updateSpApiConfigsResultSchema,
    );
    data(response, 'SP-API 配置更新响应无效');
  }

  private async feishuConfigsRaw(signal?: AbortSignal) {
    const response = await this.http.request(
      FEISHU,
      { signal, ...READ_OPTIONS },
      feishuConfigListResultSchema,
    );
    return data(response, '飞书配置响应缺少数据');
  }

  async feishuConfigs(signal?: AbortSignal) {
    return safeFeishuList(await this.feishuConfigsRaw(signal));
  }

  async upsertFeishu(
    input: { country: string; webhookUrl: string; enabled: boolean },
    signal?: AbortSignal,
  ) {
    const response = await this.http.request(
      FEISHU,
      { method: 'POST', json: input, signal, ...READ_OPTIONS },
      feishuConfigResultSchema,
    );
    data(response, '飞书配置保存响应无效');
  }

  async toggleFeishu(
    country: string,
    input: ToggleFeishuConfigRequest,
    signal?: AbortSignal,
  ) {
    const body = checked(
      toggleFeishuConfigRequestSchema,
      input,
      '飞书开关参数无效',
    );
    const response = await this.http.request(
      `${FEISHU}/${encodeURIComponent(country)}/toggle`,
      { method: 'PATCH', json: body, signal, ...READ_OPTIONS },
      feishuConfigResultSchema,
    );
    data(response, '飞书开关响应无效');
  }

  /** Toggle never resends a stored webhook; URL replacement checks the latest revision. */
  async saveFeishuChange(
    country: string,
    original: FeishuConfig | undefined,
    draft: FeishuDraft,
    signal?: AbortSignal,
  ) {
    if (draft.webhookUrl === undefined) {
      if (!original || draft.enabled === undefined)
        throw new ApiError('INVALID_INPUT', '请先填写飞书 Webhook 地址');
      if (draft.enabled && !(original.webhookUrl || original.webhook_url))
        throw new ApiError(
          'INVALID_INPUT',
          '启用飞书通知前必须填写 Webhook 地址',
        );
      await this.toggleFeishu(country, { enabled: draft.enabled }, signal);
      return;
    }
    if (!draft.webhookUrl.trim())
      throw new ApiError('INVALID_INPUT', '飞书 Webhook 地址不能为空');
    const latest = (await this.feishuConfigs(signal)).find(
      (row) => row.country === country,
    );
    if (feishuRevision(original) !== feishuRevision(latest))
      throw new ApiError(
        'BUSINESS',
        '飞书配置已被其他管理员更新，请刷新后重试',
        409,
        409,
      );
    await this.upsertFeishu(
      {
        country,
        webhookUrl: draft.webhookUrl,
        enabled:
          draft.enabled ??
          (latest ? latest.enabled === true || latest.enabled === 1 : false),
      },
      signal,
    );
  }

  async quota(signal?: AbortSignal) {
    const response = await this.http.request(
      '/api/v1/rate-limiter/status',
      { signal, ...READ_OPTIONS },
      rateLimiterStatusResultSchema,
    );
    return data(response, '配额状态响应缺少数据');
  }

  async errors(hours = 24, signal?: AbortSignal) {
    if (!Number.isFinite(hours) || hours <= 0 || hours > 168)
      throw new ApiError('INVALID_INPUT', '错误统计时间范围无效');
    const response = await this.http.request(
      '/api/v1/error-stats',
      { query: { hours }, signal, ...READ_OPTIONS },
      errorStatsResultSchema,
    );
    return data(response, '错误统计响应缺少数据');
  }
}
