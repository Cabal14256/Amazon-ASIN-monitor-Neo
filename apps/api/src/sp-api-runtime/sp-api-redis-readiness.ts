import {
  abortError,
  SpApiError,
  waitFor,
  type Logger,
} from '@asin-monitor/sp-api';

interface Probe {
  visible: Promise<void>;
  finish(): void;
}
/** One actual host connection probe. Its visible wait always ends, while a late
 * underlying ping stays registered so callers cannot accumulate more probes.
 */
export class SpApiRedisReadiness {
  private probe?: Probe;
  private closed = false;
  private warned = false;
  private readonly lifetime = new AbortController();
  constructor(
    private readonly owner: {
      client: { readonly status: string };
      ping(): Promise<void>;
    },
    private readonly logger: Logger,
    private readonly timeoutMs = 500,
  ) {
    if (
      !owner?.client ||
      typeof owner.ping !== 'function' ||
      !Number.isInteger(timeoutMs) ||
      timeoutMs < 1 ||
      timeoutMs > 500
    )
      throw new SpApiError('INVALID_CONFIG');
  }
  private warn(): void {
    if (this.closed || this.warned) return;
    this.warned = true;
    this.logger.warn('SP-API Redis connection unavailable', {
      reason: 'readiness_failed',
    });
  }
  private recovered(): void {
    if (this.closed || !this.warned || this.owner.client.status !== 'ready')
      return;
    this.warned = false;
    this.logger.info('SP-API Redis connection recovered');
  }
  async ensure(signal: AbortSignal = this.lifetime.signal): Promise<void> {
    if (this.closed) throw new SpApiError('CLOSED');
    if (!(signal instanceof AbortSignal)) throw new SpApiError('INVALID_INPUT');
    if (signal.aborted) throw abortError(signal);
    if (this.owner.client.status === 'ready') {
      this.recovered();
      return;
    }
    if (!this.probe) {
      let resolve!: () => void;
      const visible = new Promise<void>((done) => {
        resolve = done;
      });
      const timer = setTimeout(() => {
        this.warn();
        resolve();
      }, this.timeoutMs);
      const current: Probe = {
        visible,
        finish() {
          clearTimeout(timer);
          resolve();
        },
      };
      this.probe = current;
      void Promise.resolve()
        .then(async () => {
          if (this.closed) return;
          await this.owner.ping();
          this.recovered();
        })
        .catch(() => this.warn())
        .finally(() => {
          current.finish();
          if (this.probe === current) this.probe = undefined;
        });
    }
    await waitFor(this.probe.visible, signal);
    if (this.closed) throw new SpApiError('CLOSED');
    if (signal.aborted) throw abortError(signal);
  }
  close(): void {
    this.closed = true;
    this.lifetime.abort(new SpApiError('CLOSED'));
    this.probe?.finish();
  }
}
