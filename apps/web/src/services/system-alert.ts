import {
  systemAlertResultSchema,
  type SystemAlert,
} from '@asin-monitor/contracts';
import { ApiError, type HttpClient } from '../lib/http';

/** Public deployment notice; its failure must not invalidate a valid session. */
export async function getSystemAlert(
  http: Pick<HttpClient, 'request'>,
  signal?: AbortSignal,
): Promise<SystemAlert> {
  const result = await http.request(
    '/api/v1/system/alert',
    { signal, authFailure: 'ignore' },
    systemAlertResultSchema,
  );
  if (!result.success || !result.data)
    throw new ApiError('INVALID_RESPONSE', '公告响应缺少数据');
  return result.data;
}
