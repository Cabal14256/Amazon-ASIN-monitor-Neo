import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RedisWatchdog } from '../src/watchdog';

afterEach(() => {
  vi.useRealTimers();
});

describe('RedisWatchdog', () => {
  it('黑洞连接的 ping 超时后累计失败并触发恢复', async () => {
    vi.useFakeTimers();
    const ping = vi.fn(() => new Promise<string>(() => undefined));
    const onUnhealthy = vi.fn();
    const watchdog = new RedisWatchdog({ ping } as unknown as Redis, {
      intervalMs: 10,
      maxFailures: 2,
      pingTimeoutMs: 5,
    });

    watchdog.start(onUnhealthy);
    await vi.advanceTimersByTimeAsync(30);

    expect(ping).toHaveBeenCalledTimes(2);
    expect(onUnhealthy).toHaveBeenCalledOnce();
  });

  it('前一次检查未到超时时不会并发发送 ping', async () => {
    vi.useFakeTimers();
    const ping = vi.fn(() => new Promise<string>(() => undefined));
    const watchdog = new RedisWatchdog({ ping } as unknown as Redis, {
      intervalMs: 2,
      maxFailures: 2,
      pingTimeoutMs: 10,
    });

    watchdog.start(vi.fn());
    await vi.advanceTimersByTimeAsync(9);
    expect(ping).toHaveBeenCalledOnce();
    watchdog.stop();
  });
});
