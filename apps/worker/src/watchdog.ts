import { Redis } from 'ioredis';

/**
 * 队列连接看门狗（对齐旧 queueConnectionWatchdog 语义）：
 * - 每 15s 对 Redis 发 ping
 * - 连续 4 次（约 60s）不健康则退出进程，交给进程管理器重启
 */
export class RedisWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;
  private checking = false;
  private running = false;

  constructor(
    private readonly redis: Redis,
    private readonly opts: {
      intervalMs?: number;
      maxFailures?: number;
      pingTimeoutMs?: number;
    } = {},
  ) {}

  start(onUnhealthy: () => void): void {
    this.stop();
    const intervalMs = this.opts.intervalMs ?? 15_000;
    const maxFailures = this.opts.maxFailures ?? 4;
    const pingTimeoutMs = this.opts.pingTimeoutMs ?? 5_000;
    this.running = true;
    this.timer = setInterval(() => {
      if (!this.running || this.checking) return;
      this.checking = true;
      void (async () => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            this.redis.ping(),
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error('Redis ping timeout')),
                pingTimeoutMs,
              );
              timeout.unref?.();
            }),
          ]);
          if (!this.running) return;
          this.failures = 0;
        } catch {
          if (!this.running) return;
          this.failures += 1;
          if (this.failures >= maxFailures) {
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
