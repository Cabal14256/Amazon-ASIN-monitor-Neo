import { rateLimiterStatusQuerySchema } from '@asin-monitor/contracts';
import type { Region } from '@asin-monitor/sp-api';

export class SpApiStatusInputError extends Error {
  constructor() {
    super('Invalid SP-API status query');
  }
}
function queryRecord(query: unknown): Record<string, unknown> {
  if (
    !query ||
    typeof query !== 'object' ||
    Array.isArray(query) ||
    Object.keys(query).length > 20
  )
    throw new SpApiStatusInputError();
  return query as Record<string, unknown>;
}
export function parseQuotaStatusQuery(query: unknown) {
  const values = queryRecord(query);
  const optional = (value: unknown) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length > 64)
      throw new SpApiStatusInputError();
    return value.trim() || undefined;
  };
  const parsed = rateLimiterStatusQuerySchema.safeParse({
    region: optional(values.region),
    operation: optional(values.operation),
  });
  if (!parsed.success) throw new SpApiStatusInputError();
  return {
    regions: (parsed.data.region
      ? [parsed.data.region]
      : ['US', 'EU']) as Region[],
    operation: parsed.data.operation,
  };
}
export function parseErrorStatsHours(query: unknown): number {
  const { hours } = queryRecord(query);
  if (hours === undefined) return 1;
  if (
    (typeof hours !== 'number' && typeof hours !== 'string') ||
    (typeof hours === 'string' && (!hours.trim() || hours.length > 32))
  )
    throw new SpApiStatusInputError();
  const value = Number(hours);
  if (!Number.isFinite(value) || value <= 0 || value > 168)
    throw new SpApiStatusInputError();
  return value;
}
