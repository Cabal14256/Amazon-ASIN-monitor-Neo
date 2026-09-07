import { resolveConfig, snapshotConfig } from './config';
import { abortError, SpApiError, waitFor } from './errors';
import type { ConfigSource, SpApiConfig } from './types';

export type ConfigValuesReader = (
  signal: AbortSignal,
) => Promise<Readonly<Record<string, unknown>>>;
export interface DatabaseConfigSourceOptions {
  maxActive?: number;
  timeoutMs?: number;
}
const credentialKey =
  /^SP_API_(?:(?:US|EU)_)?(?:LWA_CLIENT_ID|LWA_CLIENT_SECRET|REFRESH_TOKEN|ACCESS_KEY_ID|SECRET_ACCESS_KEY|SESSION_TOKEN)$/;

/** Read current committed configuration on every get/reload. The host owns the
 * reader's pool and must also bound its I/O. No cross-process credential cache
 * or stale/ENV fallback hides an unavailable authoritative database.
 */
export class DatabaseConfigSource implements ConfigSource {
  private readonly environment: Readonly<Record<string, unknown>>;
  private readonly controllers = new Set<AbortController>();
  private readonly maxActive: number;
  private readonly timeoutMs: number;
  private closed = false;
  constructor(
    env: Readonly<Record<string, unknown>>,
    private readonly reader: ConfigValuesReader,
    options: DatabaseConfigSourceOptions = {},
  ) {
    this.maxActive = options.maxActive ?? 16;
    this.timeoutMs = options.timeoutMs ?? 5000;
    if (
      !env ||
      typeof env !== 'object' ||
      typeof reader !== 'function' ||
      !Number.isInteger(this.maxActive) ||
      this.maxActive < 1 ||
      this.maxActive > 64 ||
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 10_000
    )
      throw new SpApiError('INVALID_CONFIG');
    this.environment = Object.freeze(
      Object.fromEntries(
        Object.entries(env).filter(
          ([key]) =>
            credentialKey.test(key) || key === 'SP_API_USE_AWS_SIGNATURE',
        ),
      ),
    );
    snapshotConfig(resolveConfig(this.environment));
  }
  get(signal: AbortSignal): Promise<SpApiConfig> {
    return this.load(signal);
  }
  reload(signal: AbortSignal): Promise<SpApiConfig> {
    return this.load(signal);
  }
  private async load(signal: AbortSignal): Promise<SpApiConfig> {
    if (this.closed) throw new SpApiError('CLOSED');
    if (!(signal instanceof AbortSignal)) throw new SpApiError('INVALID_INPUT');
    if (signal.aborted) throw abortError(signal);
    if (this.controllers.size >= this.maxActive)
      throw new SpApiError('CAPACITY');
    const controller = new AbortController();
    const abort = () => controller.abort(abortError(signal));
    signal.addEventListener('abort', abort, { once: true });
    this.controllers.add(controller);
    const timer = setTimeout(
      () => controller.abort(new SpApiError('TIMEOUT')),
      this.timeoutMs,
    );
    const ensureActive = () => {
      if (controller.signal.aborted) throw abortError(controller.signal);
    };
    const work = Promise.resolve()
      .then(async () => {
        ensureActive();
        const values = await this.reader(controller.signal);
        ensureActive();
        if (
          !values ||
          typeof values !== 'object' ||
          Array.isArray(values) ||
          Object.keys(values).length > 200
        )
          throw new SpApiError('INVALID_CONFIG');
        return snapshotConfig(resolveConfig(this.environment, values));
      })
      .catch((error: unknown) => {
        throw error instanceof SpApiError
          ? error
          : new SpApiError('DEPENDENCY_ERROR');
      })
      .finally(() => {
        // A deadline is not proof the supplied reader ended. Keep its admission
        // until settlement, so repeated timeouts cannot accumulate pool requests.
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        this.controllers.delete(controller);
      });
    return waitFor(work, controller.signal);
  }
  close(): void {
    this.closed = true;
    for (const controller of this.controllers)
      controller.abort(new SpApiError('CLOSED'));
  }
}
