import {
  errorStatsResultSchema,
  feishuConfigListResultSchema,
  feishuConfigResultSchema,
  feishuRevisionSchema,
  rateLimiterStatusResultSchema,
  spApiDisplayConfigListResultSchema,
  toggleFeishuConfigRequestSchema,
  updateSpApiConfigsRequestSchema,
  updateSpApiConfigsResultSchema,
  upsertFeishuConfigRequestSchema,
  type FeishuConfig,
  type SpApiDisplayConfig,
  type ToggleFeishuConfigRequest,
  type UpdateSpApiConfigsRequest,
  type UpsertFeishuConfigRequest,
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

/** Imported Legacy country keys may differ in case or have trailing spaces. */
export function feishuCountryKey(country: string) {
  return country.trimEnd().toUpperCase();
}

function feishuRevision(row: FeishuConfig | undefined) {
  return row
    ? JSON.stringify([
        row.id,
        row.revision,
        row.updateTime ?? row.update_time,
        row.enabled,
        Boolean(row.webhookUrl || row.webhook_url),
      ])
    : null;
}

function validWebhookUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.hash
    );
  } catch {
    return false;
  }
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
    input: Omit<UpsertFeishuConfigRequest, 'expectedRevision'> & {
      expectedRevision: string | null;
    },
    signal?: AbortSignal,
  ) {
    const body = checked(
      upsertFeishuConfigRequestSchema,
      input,
      '飞书配置参数无效',
    );
    const response = await this.http.request(
      FEISHU,
      { method: 'POST', json: body, signal, ...READ_OPTIONS },
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
      try {
        await this.toggleFeishu(
          original.country,
          { enabled: draft.enabled },
          signal,
        );
      } catch (error) {
        if (
          draft.enabled !== false ||
          !(error instanceof ApiError) ||
          error.status !== 404 ||
          error.errorCode !== 404
        )
          throw error;
        // Legacy commits a disable, then its enabled-only read returns 404.
        // A missing row also returns 404, so confirm the original row is still
        // present and disabled before treating this response as success.
        const latest = (await this.feishuConfigs(signal)).find(
          (row) => feishuCountryKey(row.country) === feishuCountryKey(country),
        );
        if (
          latest?.id !== original.id ||
          (latest.enabled !== false && latest.enabled !== 0)
        )
          throw error;
      }
      return;
    }
    if (!draft.webhookUrl.trim())
      throw new ApiError('INVALID_INPUT', '飞书 Webhook 地址不能为空');
    if (!validWebhookUrl(draft.webhookUrl))
      throw new ApiError('INVALID_INPUT', '请输入有效的 HTTPS Webhook 地址');
    const latest = (await this.feishuConfigs(signal)).find(
      (row) => feishuCountryKey(row.country) === feishuCountryKey(country),
    );
    if (feishuRevision(original) !== feishuRevision(latest))
      throw new ApiError(
        'BUSINESS',
        '飞书配置已被其他管理员更新；输入已保留，请查看刷新后的配置并重新编辑',
        409,
        409,
      );
    let expectedRevision: string | null = null;
    if (latest) {
      const parsed = feishuRevisionSchema.safeParse(latest.revision);
      if (!parsed.success)
        throw new ApiError(
          'INVALID_RESPONSE',
          '飞书配置缺少版本信息，请刷新后重试',
        );
      expectedRevision = parsed.data;
    }
    try {
      await this.upsertFeishu(
        {
          country: latest?.country ?? country,
          webhookUrl: draft.webhookUrl,
          enabled:
            draft.enabled ??
            (latest ? latest.enabled === true || latest.enabled === 1 : false),
          expectedRevision,
        },
        signal,
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 409)
        throw new ApiError(
          'BUSINESS',
          '飞书配置已被其他管理员更新；输入已保留，请查看刷新后的配置并重新编辑',
          409,
          409,
        );
      throw error;
    }
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
