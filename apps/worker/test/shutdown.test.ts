import { describe, expect, it, vi } from 'vitest';

import { shutdownWorker } from '../src/shutdown';

describe('Worker 退出', () => {
  it('单个连接关闭失败时仍清理其他连接并退出', async () => {
    const stop = vi.fn();
    const healthyClose = vi.fn().mockResolvedValue(undefined);
    const failedClose = vi.fn().mockRejectedValue(new Error('redis down'));
    const quit = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await shutdownWorker({
      watchdog: { stop },
      queues: [{ close: failedClose }, { close: healthyClose }],
      watchdogRedis: { quit },
      exit,
    });

    expect(stop).toHaveBeenCalledOnce();
    expect(healthyClose).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('连接关闭卡住时在截止时间后退出', async () => {
    const exit = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await shutdownWorker({
      watchdog: { stop: vi.fn() },
      queues: [{ close: () => new Promise(() => undefined) }],
      watchdogRedis: { quit: vi.fn().mockResolvedValue(undefined) },
      timeoutMs: 1,
      exit,
    });

    expect(exit).toHaveBeenCalledWith(0);
  });
});
