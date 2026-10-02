/** Keep immediate-check feedback useful without rendering the full result payload. */
export function summarizeCheckResult(
  value: unknown,
  suffix = '，目录已更新。',
): string {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return `检查完成${suffix}`;

  const result = value as Record<string, unknown>;
  if (typeof result.isBroken === 'boolean') {
    return result.isBroken
      ? `检查完成：发现异常${suffix}`
      : `检查完成：未发现异常${suffix}`;
  }

  const details = result.details;
  const groupResults =
    details &&
    typeof details === 'object' &&
    !Array.isArray(details) &&
    (details as Record<string, unknown>).results;
  if (Array.isArray(groupResults)) {
    return `检查完成：已返回 ${groupResults.length} 项结果${suffix}`;
  }

  return `检查完成${suffix}`;
}
