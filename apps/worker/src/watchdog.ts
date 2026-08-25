import { Redis } from 'ioredis';

/** 同一探针未结束时复用原 Promise，避免外层超时后重复堆积 Redis 命令。 */
export function createSingleFlightCheck(
  check: () => Promise<unknown>,
): () => Promise<unknown> {
  let inFlight: Promise<unknown> | undefined;
  return () => {
    if (!inFlight) {
      const current = Promise.resolve().then(() => check());
      inFlight = current;
      void current.then(
        () => {
          if (inFlight === current) inFlight = undefined;
        },
        () => {
          if (inFlight === current) inFlight = undefined;
        },
      );
    }
    return inFlight;
  };
}

/**
 * 队列连接看门狗（对齐旧 queueConnectionWatchdog 语义）：
 * - 每 15s 对 Redis 发 ping
 * - 从首次失败起持续 60s 不健康才退出，交给进程管理器重启
 */
export class RedisWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private failedAt: number | null = null;
  private checking = false;
  private running = false;

  constructor(
    private readonly redis: Redis,
    private readonly opts: {
      intervalMs?: number;
      pingTimeoutMs?: number;
      unhealthyMs?: number;
      now?: () => number;
      checks?: ReadonlyArray<() => Promise<unknown>>;
    } = {},
  ) {}

  start(onUnhealthy: () => void): void {
    this.stop();
    const intervalMs = this.opts.intervalMs ?? 15_000;
    const pingTimeoutMs = this.opts.pingTimeoutMs ?? 5_000;
    const unhealthyMs = this.opts.unhealthyMs ?? 60_000;
    const now = this.opts.now ?? Date.now;
    this.failedAt = null;
    this.running = true;
    this.timer = setInterval(() => {
      if (!this.running || this.checking) return;
      this.checking = true;
      void (async () => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.all([
              this.redis.ping(),
              ...(this.opts.checks ?? []).map((check) => check()),
            ]),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error('Redis ping timeout')),
                pingTimeoutMs,
              );
              timeout.unref?.();
            }),
          ]);
          if (!this.running) return;
          this.failedAt = null;
        } catch {
          if (!this.running) return;
          if (this.failedAt === null) {
            this.failedAt = now();
          }
          if (Math.max(now() - this.failedAt, 0) >= unhealthyMs) {
            this.stop();
            onUnhealthy();
          }
        } finally {
          if (timeout) clearTimeout(timeout);
          this.checking = false;
        }
      })();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
