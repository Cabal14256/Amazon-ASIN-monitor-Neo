import type { FeishuCard, NotificationDomain } from './types';

export interface NotificationConfiguration {
  webhookUrl: string;
}
export interface NotificationConfigSource {
  /** Fresh enabled-only, exact region lookup, never a stale credential fallback. */
  read(
    domain: NotificationDomain,
    region: string,
    signal: AbortSignal,
  ): Promise<NotificationConfiguration | undefined>;
  close?(): void;
}
export interface NotificationTransport {
  /** One POST attempt; honor cancellation and never redirect or retry secretly. */
  send(
    webhookUrl: string,
    card: FeishuCard,
    signal: AbortSignal,
  ): Promise<{ statusCode: number; code?: unknown }>;
  close(): void;
}
export interface NotificationLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}
export interface NotificationResult {
  success: boolean;
  errorCode?: number | string;
}
export interface CountryNotificationResult extends NotificationResult {
  skipped: false;
}
export interface BatchNotificationResult {
  total: number;
  success: number;
  failed: number;
  skipped: 0;
  countryResults: Record<string, CountryNotificationResult>;
}
