import type { Pool, PoolClient } from 'pg';

export class FeishuNotificationConfigError extends Error {
  constructor(
    readonly reason:
      | 'invalid-input'
      | 'invalid-result'
      | 'capacity'
      | 'cancelled'
      | 'closed'
      | 'timeout'
      | 'dependency',
  ) {
    super(`Notification configuration ${reason}`);
    this.name = 'FeishuNotificationConfigError';
  }
}
/** Internal credential reader, distinct from user-facing masked configuration
 * endpoints. Owns only borrowed connections, never the host's pool. */
export class PgFeishuNotificationConfigReader {
  private active = 0;
  private closed = false;
  private readonly stops = new Set<() => void>();
  private readonly table: 'feishu_config' | 'competitor_feishu_config';
  constructor(private readonly pool: Pool, domain: 'primary' | 'competitor') {
    if (domain !== 'primary' && domain !== 'competitor')
      throw new FeishuNotificationConfigError('invalid-input');
    this.table =
      domain === 'primary' ? 'feishu_config' : 'competitor_feishu_config';
  }
  getDiagnostics() {
    return { pendingReads: this.active, closed: this.closed };
  }
  async read(
    region: string,
    signal?: AbortSignal,
  ): Promise<{ webhookUrl: string } | undefined> {
    if (this.closed) throw new FeishuNotificationConfigError('closed');
    if (signal?.aborted) throw new FeishuNotificationConfigError('cancelled');
    if (
      typeof region !== 'string' ||
      !region ||
      [...region].length > 10 ||
      region.includes('\0')
    )
      throw new FeishuNotificationConfigError('invalid-input');
    if (this.active >= 8) throw new FeishuNotificationConfigError('capacity');
    this.active++;
    let client: PoolClient | undefined,
      released = false;
    let stopped: FeishuNotificationConfigError | undefined;
    let rejectInterrupt!: (error: FeishuNotificationConfigError) => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      rejectInterrupt = reject;
    });
    const release = (destroy: boolean) => {
      if (client && !released) {
        released = true;
        client.removeListener('error', onError);
        client.release(destroy);
      }
    };
    const stop = (
      reason: 'cancelled' | 'closed' | 'timeout' | 'dependency',
    ) => {
      if (stopped) return;
      stopped = new FeishuNotificationConfigError(reason);
      release(true);
      rejectInterrupt(stopped);
    };
    const onError = () => stop('dependency');
    const abort = () => stop('cancelled'),
      close = () => stop('closed');
    const ensure = () => {
      if (stopped) throw stopped;
    };
    signal?.addEventListener('abort', abort, { once: true });
    this.stops.add(close);
    const timer = setTimeout(() => stop('timeout'), 2000);
    if (signal?.aborted) abort();
    const work = (async () => {
      let failed = true;
      try {
        ensure();
        client = await this.pool.connect();
        // A timed-out pool acquisition still owns a slot until it actually
        // settles. Release a late connection before executing any statement.
        if (stopped) {
          release(true);
          throw stopped;
        }
        client.on('error', onError);
        await client.query('BEGIN READ ONLY');
        ensure();
        await client.query('SET LOCAL statement_timeout = 1500');
        ensure();
        await client.query(
          'SELECT pg_advisory_xact_lock_shared(1095977294,1380073795)',
        );
        ensure();
        const result = await client.query<{
          webhook_url: unknown;
          enabled: unknown;
        }>(
          `SELECT left(webhook_url,501) AS webhook_url,enabled FROM ${this.table} WHERE rtrim(country) COLLATE public.neo_notification_country_ci = rtrim($1) LIMIT 2`,
          [region],
        );
        ensure();
        if (result.rows.length > 1)
          throw new FeishuNotificationConfigError('invalid-result');
        const row = result.rows[0];
        if (
          row &&
          (typeof row.webhook_url !== 'string' ||
            [...row.webhook_url].length > 500 ||
            (row.enabled !== null && typeof row.enabled !== 'boolean'))
        )
          throw new FeishuNotificationConfigError('invalid-result');
        await client.query('COMMIT');
        ensure();
        failed = false;
        return row?.enabled === true
          ? { webhookUrl: row.webhook_url as string }
          : undefined;
      } finally {
        release(failed);
        this.active--;
      }
    })();
    try {
      return await Promise.race([work, interrupted]);
    } catch (error) {
      throw error instanceof FeishuNotificationConfigError
        ? error
        : new FeishuNotificationConfigError('dependency');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.stops.delete(close);
    }
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const stop of this.stops) stop();
  }
}
