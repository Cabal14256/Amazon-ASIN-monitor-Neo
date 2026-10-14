function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function failureDetails(error: unknown) {
  const value = record(error);
  const response = record(value?.response);
  const data = record(value?.data) ?? record(response?.data) ?? response;
  // An actual HTTP failure wins over a conflicting JSON errorCode.
  const status = response?.status ?? value?.status ?? data?.errorCode;
  return { status, data };
}

export function isMissingScheduledBackupRoute(error: unknown): boolean {
  const { status, data } = failureDetails(error);
  // This is the unchanged Legacy server/src/index.js missing-route envelope.
  // A generic 404 from a deployed endpoint is a lookup failure, not absence.
  return status === 404 && data?.errorMessage === '接口不存在';
}

export function scheduledHistoryFailureMessage(error: unknown): string {
  const { status } = failureDetails(error);
  if (status === 401)
    return '登录已失效，无法读取自动备份执行记录，请重新登录。';
  if (status === 403) return '当前账号无权读取自动备份执行记录。';
  if (status === 429) return '自动备份执行记录请求过于频繁，请稍后重新读取。';
  return '自动备份执行记录读取失败，请重新读取；当前无法确认是否存在执行记录。';
}

export async function readScheduledBackupHistory<T>(
  read: () => Promise<{ success?: boolean; data?: T[] }>,
): Promise<
  { kind: 'available'; tasks: T[] } | { kind: 'unsupported'; tasks: [] }
> {
  try {
    const response = await read();
    if (response?.success === false || !Array.isArray(response?.data)) {
      const error = new Error(
        'Invalid scheduled backup history response',
      ) as Error & {
        data: unknown;
      };
      error.data = response;
      throw error;
    }
    return { kind: 'available', tasks: response.data };
  } catch (error) {
    if (isMissingScheduledBackupRoute(error))
      return { kind: 'unsupported', tasks: [] };
    throw error;
  }
}
