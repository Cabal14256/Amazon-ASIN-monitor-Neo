import { NodeHttpTransport } from '@asin-monitor/sp-api';
import { NotificationError } from './errors';
import type { NotificationTransport } from './ports';
import type { FeishuCard } from './types';

/** Share the already bounded Node HTTP implementation; no SP-API quota,
 * credentials, redirects or retries are attached to a notification POST. */
export class NodeFeishuTransport implements NotificationTransport {
  private readonly http: NodeHttpTransport;
  constructor(
    options: {
      allowLocalHttp?: boolean;
      timeoutMs?: number;
      maxResponseBytes?: number;
    } = {},
  ) {
    if (
      (options.timeoutMs ?? 10_000) > 10_000 ||
      (options.maxResponseBytes ?? 65_536) > 65_536
    )
      throw new NotificationError('invalid-config');
    this.http = new NodeHttpTransport({
      ...options,
      timeoutMs: options.timeoutMs ?? 10_000,
      maxResponseBytes: options.maxResponseBytes ?? 65_536,
      maxInFlight: 8,
    });
  }
  async send(webhookUrl: string, card: FeishuCard, signal: AbortSignal) {
    let url: URL;
    try {
      url = new URL(webhookUrl);
    } catch {
      throw new NotificationError('invalid-config');
    }
    const result = await this.http.request({
      url,
      method: 'POST',
      // Webhook hosts can rotate. Do not retain idle agent sockets for an
      // unbounded sequence of origins; active I/O remains capped at eight.
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify({ msg_type: 'interactive', card }),
      signal,
    });
    let code: unknown;
    try {
      const body: unknown = JSON.parse(result.body);
      if (body && typeof body === 'object' && !Array.isArray(body))
        code = (body as Record<string, unknown>).code;
    } catch {
      /* Axios exposes non-JSON as text: Legacy falls back to HTTP status. */
    }
    return { statusCode: result.statusCode, code };
  }
  close() {
    this.http.close();
  }
}
