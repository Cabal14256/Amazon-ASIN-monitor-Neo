import { logger } from './logger';

interface WatchdogLike {
  stop(): void;
}

interface QueueLike {
  close(): Promise<unknown>;
}

interface RedisLike {
  quit(): Promise<unknown>;
}

interface ShutdownOptions {
  watchdog: WatchdogLike;
  queues: QueueLike[];
  watchdogRedis: RedisLike;
  timeoutMs?: number;
  exit?: (code: number) => unknown;
}

type CloseOutcome =
  | { kind: 'settled'; results: PromiseSettledResult<unknown>[] }
  | { kind: 'timeout' };

/** 独立收敛每个连接；即使 Redis 故障或 close 卡住，也保证进程最终退出。 */
export async function shutdownWorker({
  watchdog,
  queues,
  watchdogRedis,
  timeoutMs = 10_000,
  exit = (code) => process.exit(code),
}: ShutdownOptions): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    try {
      watchdog.stop();
    } catch {
      logger.warn('停止 Redis 看门狗失败，继续关闭 Worker');
    }

    const operations = [
      ...queues.map((queue) => Promise.resolve().then(() => queue.close())),
      Promise.resolve().then(() => watchdogRedis.quit()),
    ];
    const settled = Promise.allSettled(operations).then(
      (results): CloseOutcome => ({ kind: 'settled', results }),
    );
    const timedOut = new Promise<CloseOutcome>((resolve) => {
      timeout = setTimeout(() => resolve({ kind: 'timeout' }), timeoutMs);
    });
    const outcome = await Promise.race([settled, timedOut]);

    if (outcome.kind === 'timeout') {
      logger.warn('Worker 连接关闭超时，将强制退出', { timeoutMs });
    } else {
      const failureCount = outcome.results.filter(
        (result) => result.status === 'rejected',
      ).length;
      if (failureCount > 0) {
        logger.warn('部分 Worker 连接关闭失败，将继续退出', {
          failureCount,
        });
      }
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    exit(0);
  }
}
