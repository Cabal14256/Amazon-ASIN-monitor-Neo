import {
  abnormalDurationQuerySchema,
  monitorAnalyticsDataSchemas,
  resultSchema,
  type AbnormalDurationQuery,
} from '@asin-monitor/contracts';
import { ApiError, type HttpClient } from '../lib/http';

export type AbnormalDurationRead = ReturnType<
  (typeof monitorAnalyticsDataSchemas)['abnormal-duration-statistics']['parse']
>;
export type AbnormalDurationScope = Omit<
  AbnormalDurationQuery,
  'asinIds' | 'asinCodes' | 'includeSeries' | 'startTime' | 'endTime'
> & {
  asinIds?: string[];
  asinCodes?: string[];
  includeSeries: '0';
  startTime: string;
  endTime: string;
};
const PATH = '/api/v1/monitor-history/abnormal-duration-statistics';
const RESPONSE_SCHEMA = resultSchema(
  monitorAnalyticsDataSchemas['abnormal-duration-statistics'],
);

/** Bracket arrays preserve opaque identifiers; this endpoint alone accepts them. */
export function abnormalDurationPath(query: AbnormalDurationScope): string {
  const parsed = abnormalDurationQuerySchema.safeParse(query);
  if (!parsed.success || parsed.data.includeSeries !== '0')
    throw new ApiError('INVALID_INPUT', '异常时长查询参数无效');
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value === undefined || value === '') continue;
    if (key === 'asinIds' || key === 'asinCodes') {
      if (!Array.isArray(value) || value.length > 1000)
        throw new ApiError('INVALID_INPUT', '异常时长 ASIN 范围无效');
      for (const item of value) {
        if ([...item].length > (key === 'asinIds' ? 50 : 200))
          throw new ApiError('INVALID_INPUT', '异常时长 ASIN 范围无效');
        params.append(`${key}[]`, item);
      }
    } else params.set(key, String(value));
  }
  return `${PATH}?${params.toString()}`;
}

export async function getAbnormalDurationStatistics(
  http: Pick<HttpClient, 'request'>,
  query: AbnormalDurationScope,
  signal?: AbortSignal,
): Promise<AbnormalDurationRead> {
  const response = await http.request(
    abnormalDurationPath(query),
    { signal, timeoutMs: 120_000, maxResponseBytes: 32 * 1024 * 1024 },
    RESPONSE_SCHEMA,
  );
  if (response.success !== true || response.data === undefined)
    throw new ApiError('INVALID_RESPONSE', '服务器响应不完整');
  return response.data;
}
