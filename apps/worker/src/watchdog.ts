import { Redis } from 'ioredis';

/**
 * 队列连接看门狗（对齐旧 queueConnectionWatchdog 语义）：
 * - 每 15s 对 Redis 发 ping
 * - 连续 4 次（约 60s）不健康则退出进程，交给进程管理器重启
 */
export class RedisWatchdog {
  private timer: NodeJS.Timeout | null = null;
  private failures = 0;

  constructor(
    private readonly redis: Redis,
    private readonly opts: { intervalMs?: number; maxFailures?: number } = {},
  ) {}

  start(onUnhealthy: () => void): void {
    const intervalMs = this.opts.intervalMs ?? 15_000;
    const maxFailures = this.opts.maxFailures ?? 4;
    this.timer = setInterval(() => {
      void (async () => {
        try {
          await this.redis.ping();
          this.failures = 0;
        } catch {
          this.failures += 1;
          if (this.failures >= maxFailures) {
            this.stop();
            onUnhealthy();
          }
        }
      })();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
