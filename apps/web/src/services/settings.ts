import {
  errorStatsResultSchema,
  feishuConfigListResultSchema,
  feishuConfigResultSchema,
  rateLimiterStatusResultSchema,
  spApiDisplayConfigListResultSchema,
  toggleFeishuConfigRequestSchema,
  updateSpApiConfigsResultSchema,
  updateSpApiConfigsRequestSchema,
  type ToggleFeishuConfigRequest,
  type UpdateSpApiConfigsRequest,
} from '@asin-monitor/contracts';
import { ApiError, type HttpClient } from '../lib/http';

const CONFIG = '/api/v1/sp-api-configs';
const FEISHU = '/api/v1/feishu-configs';
const READ_OPTIONS = { timeoutMs: 60_000, maxResponseBytes: 8 * 1024 * 1024 } as const;

function data<T>(response: { success?: boolean; data?: T }, message: string): T {
  if (response.success !== true || response.data === undefined)
    throw new ApiError('INVALID_RESPONSE', message);
  return response.data;
}

function checked<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
  message: string,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ApiError('INVALID_INPUT', message);
  return parsed.data;
}

export class SettingsApi {
  constructor(private readonly http: Pick<HttpClient, 'request'>) {}

  async spApiConfigs(signal?: AbortSignal) {
    const response = await this.http.request(
      CONFIG,
      { signal, ...READ_OPTIONS },
      spApiDisplayConfigListResultSchema,
    );
    return data(response, 'SP-API 配置响应缺少数据');
  }

  async updateSpApiConfigs(input: UpdateSpApiConfigsRequest, signal?: AbortSignal) {
    const body = checked(updateSpApiConfigsRequestSchema, input, 'SP-API 配置参数无效');
    const response = await this.http.request(
      CONFIG,
      { method: 'PUT', json: body, signal, ...READ_OPTIONS },
      updateSpApiConfigsResultSchema,
    );
    return data(response, 'SP-API 配置更新响应无效');
  }

  async feishuConfigs(signal?: AbortSignal) {
    const response = await this.http.request(
      FEISHU,
      { signal, ...READ_OPTIONS },
      feishuConfigListResultSchema,
    );
    return data(response, '飞书配置响应缺少数据');
  }

  async upsertFeishu(input: { country: string; webhookUrl: string; enabled: boolean }, signal?: AbortSignal) {
    const response = await this.http.request(
      FEISHU,
      { method: 'POST', json: input, signal, ...READ_OPTIONS },
      feishuConfigResultSchema,
    );
    return data(response, '飞书配置保存响应无效');
  }

  async toggleFeishu(country: string, input: ToggleFeishuConfigRequest, signal?: AbortSignal) {
    const body = checked(toggleFeishuConfigRequestSchema, input, '飞书开关参数无效');
    const response = await this.http.request(
      `${FEISHU}/${encodeURIComponent(country)}/toggle`,
      { method: 'PATCH', json: body, signal, ...READ_OPTIONS },
      feishuConfigResultSchema,
    );
    return data(response, '飞书开关响应无效');
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
