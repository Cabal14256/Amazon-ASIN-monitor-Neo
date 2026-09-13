import { buildCompetitorFeishuCard, buildFeishuCard } from './cards';
import {
  abortable,
  ensureActive,
  notificationDelay,
  NotificationError,
  signalError,
} from './errors';
import {
  notificationCountry,
  notificationDomain,
  snapshotNotification,
} from './input';
import type {
  BatchNotificationResult,
  CountryNotificationResult,
  NotificationConfigSource,
  NotificationLogger,
  NotificationResult,
  NotificationTransport,
} from './ports';
import type { NotificationData, NotificationDomain } from './types';

const countryNames: Record<string, string> = {
  US: '美国',
  UK: '英国',
  DE: '德国',
  FR: '法国',
  IT: '意大利',
  ES: '西班牙',
};
const regionFor = (country: string) =>
  ['UK', 'DE', 'FR', 'IT', 'ES'].includes(country) ? 'EU' : country;
const codeValue = (code: unknown) =>
  typeof code === 'number' && Number.isFinite(code)
    ? code
    : typeof code === 'string' &&
      code.length <= 64 &&
      code.trim() !== '' &&
      Number.isFinite(Number(code))
    ? code
    : undefined;
export class FeishuNotifications {
  private closed = false;
  private readonly active = new Set<AbortController>();
  private pending = 0;
  private readonly stats = {
    attempts: 0,
    sent: 0,
    failed: 0,
    rateLimitedRetries: 0,
  };
  constructor(
    private readonly options: {
      source: NotificationConfigSource;
      transport: NotificationTransport;
      logger: NotificationLogger;
      random?: () => number;
      delay?: (ms: number, signal: AbortSignal) => Promise<void>;
      operationTimeoutMs?: number;
      configTimeoutMs?: number;
      requestTimeoutMs?: number;
    },
  ) {
    for (const [value, max] of [
      [options.operationTimeoutMs ?? 720_000, 720_000],
      [options.configTimeoutMs ?? 2000, 2000],
      [options.requestTimeoutMs ?? 10_000, 10_000],
    ]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > max)
        throw new NotificationError('invalid-config');
    }
  }
  getDiagnostics() {
    return {
      ...this.stats,
      activeOperations: this.active.size,
      pendingDependencies: this.pending,
      closed: this.closed,
    };
  }
  private async operation<T>(
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.closed) throw new NotificationError('closed');
    if (this.active.size >= 4) throw new NotificationError('capacity');
    const controller = new AbortController();
    const abort = () => controller.abort(new NotificationError('cancelled'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(
      () => controller.abort(new NotificationError('timeout')),
      this.options.operationTimeoutMs ?? 720_000,
    );
    this.active.add(controller);
    try {
      ensureActive(controller.signal);
      return await run(controller.signal);
    } catch (error) {
      controller.abort(
        error instanceof NotificationError
          ? error
          : new NotificationError('dependency'),
      );
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      this.active.delete(controller);
    }
  }
  private async dependency<T>(
    signal: AbortSignal,
    timeout: number,
    task: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    ensureActive(signal);
    if (this.pending >= 8) throw new NotificationError('capacity');
    const controller = new AbortController(),
      abort = () => controller.abort(signalError(signal));
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new NotificationError('timeout')),
      timeout,
    );
    this.pending++;
    // Retain the dependency slot until the underlying operation really settles,
    // including custom adapters that ignore cancellation. Never grow a hidden queue.
    const promise = Promise.resolve()
      .then(() => {
        ensureActive(controller.signal);
        return task(controller.signal);
      })
      .finally(() => {
        this.pending--;
      });
    try {
      return await abortable(promise, controller.signal);
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
    }
  }
  private async attempt(
    domain: NotificationDomain,
    region: string,
    data: NotificationData,
    signal: AbortSignal,
  ): Promise<NotificationResult> {
    try {
      const config = await this.dependency(
        signal,
        this.options.configTimeoutMs ?? 2000,
        (child) => this.options.source.read(domain, region, child),
      );
      ensureActive(signal);
      if (!config || !config.webhookUrl) {
        this.options.logger.info('飞书通知未配置或已禁用', { domain });
        return { success: false };
      }
      if (
        typeof config.webhookUrl !== 'string' ||
        [...config.webhookUrl].length > 500 ||
        /[\r\n\0]/.test(config.webhookUrl)
      )
        throw new NotificationError('invalid-config');
      const card =
        domain === 'primary'
          ? buildFeishuCard(data)
          : buildCompetitorFeishuCard(data);
      if (Buffer.byteLength(JSON.stringify(card)) > 1024 * 1024)
        throw new NotificationError('invalid-input');
      this.stats.attempts++;
      const response = await this.dependency(
        signal,
        this.options.requestTimeoutMs ?? 10_000,
        (child) => this.options.transport.send(config.webhookUrl, card, child),
      );
      ensureActive(signal);
      if (
        !Number.isInteger(response.statusCode) ||
        response.statusCode < 100 ||
        response.statusCode > 599
      )
        throw new NotificationError('dependency');
      if (response.statusCode === 200 && response.code === 0) {
        this.stats.sent++;
        this.options.logger.info('飞书通知发送成功', { domain });
        return { success: true };
      }
      this.stats.failed++;
      this.options.logger[
        Number(codeValue(response.code)) === 11232 ? 'warn' : 'error'
      ]('飞书通知发送失败', {
        domain,
        reason: 'upstream_response',
      });
      return {
        success: false,
        errorCode: codeValue(response.code) || response.statusCode,
      };
    } catch (error) {
      ensureActive(signal);
      this.stats.failed++;
      this.options.logger.error('飞书通知发送失败', {
        domain,
        reason:
          error instanceof NotificationError ? error.reason : 'dependency',
      });
      return { success: false, errorCode: undefined };
    }
  }
  private async retry(
    domain: NotificationDomain,
    region: string,
    data: NotificationData,
    signal: AbortSignal,
  ) {
    for (let attempt = 1; ; attempt++) {
      const result = await this.attempt(domain, region, data, signal);
      if (result.success || Number(result.errorCode) !== 11232 || attempt === 3)
        return result;
      const random = (this.options.random ?? Math.random)();
      if (!Number.isFinite(random) || random < 0 || random >= 1)
        throw new NotificationError('invalid-config');
      this.stats.rateLimitedRetries++;
      this.options.logger.warn('飞书通知限频，将重试', {
        domain,
        nextAttempt: attempt + 1,
      });
      await this.pause(2000 + Math.floor(random * 2000), signal);
      ensureActive(signal);
    }
  }
  private pause(ms: number, signal: AbortSignal) {
    return this.dependency(signal, ms + 1000, (child) =>
      (this.options.delay ?? notificationDelay)(ms, child),
    );
  }
  sendOnce(
    domain: NotificationDomain,
    region: string,
    data: NotificationData,
    signal?: AbortSignal,
  ): Promise<NotificationResult> {
    return this.operation(signal, (child) =>
      this.attempt(
        notificationDomain(domain),
        notificationCountry(region),
        snapshotNotification(data),
        child,
      ),
    );
  }
  sendCountry(
    domain: NotificationDomain,
    country: string,
    data: NotificationData,
    signal?: AbortSignal,
  ): Promise<CountryNotificationResult> {
    return this.operation(signal, async (child) => {
      notificationDomain(domain);
      notificationCountry(country);
      const result = await this.retry(
        domain,
        regionFor(country),
        this.countryData(country, snapshotNotification(data)),
        child,
      );
      return result.success
        ? { success: true, skipped: false }
        : { success: false, skipped: false, errorCode: result.errorCode };
    });
  }
  private countryData(
    country: string,
    data: NotificationData,
  ): NotificationData {
    const name = Object.hasOwn(countryNames, country)
      ? countryNames[country]
      : country;
    return {
      ...data,
      country,
      countryDisplay: `${name}(${country})`,
      region: regionFor(country),
    };
  }
  sendBatch(
    domain: NotificationDomain,
    input: Record<string, NotificationData>,
    signal?: AbortSignal,
  ): Promise<BatchNotificationResult> {
    return this.operation(signal, async (child) => {
      notificationDomain(domain);
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new NotificationError('invalid-input');
      const countries = Object.keys(input);
      if (
        countries.length > 32 ||
        Object.values(Object.getOwnPropertyDescriptors(input)).some(
          (field) => field.get || field.set,
        )
      )
        throw new NotificationError('invalid-input');
      let bytes = 0;
      const entries = countries.map((country) => {
        const data = this.countryData(
          notificationCountry(country),
          snapshotNotification(input[country]),
        );
        bytes += Buffer.byteLength(JSON.stringify(data));
        if (bytes > 8 * 1024 * 1024)
          throw new NotificationError('invalid-input');
        return { country, data };
      });
      const result: BatchNotificationResult = {
        total: 0,
        success: 0,
        failed: 0,
        skipped: 0,
        countryResults: {},
      };
      for (let index = 0; index < entries.length; index += 2) {
        ensureActive(child);
        await Promise.all(
          entries.slice(index, index + 2).map(async ({ country, data }) => {
            result.total++;
            const outcome = await this.retry(
              domain,
              regionFor(country),
              data,
              child,
            );
            if (outcome.success) result.success++;
            else result.failed++;
            Object.defineProperty(result.countryResults, country, {
              enumerable: true,
              configurable: true,
              writable: true,
              value: outcome.success
                ? { success: true, skipped: false }
                : {
                    success: false,
                    skipped: false,
                    errorCode: outcome.errorCode,
                  },
            });
          }),
        );
        if (index + 2 < entries.length) await this.pause(500, child);
      }
      return result;
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.active)
      controller.abort(new NotificationError('closed'));
    this.options.transport.close();
    this.options.source.close?.();
  }
}
