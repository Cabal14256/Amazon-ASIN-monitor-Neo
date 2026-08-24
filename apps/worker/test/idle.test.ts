import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';

import { waitForShutdownSignal } from '../src/idle';

describe('空闲 Worker 生命周期', () => {
  it('不创建 Redis 资源时仍等待停止信号并清理监听器', async () => {
    const source = new EventEmitter();
    const waiting = waitForShutdownSignal(
      source as unknown as Parameters<typeof waitForShutdownSignal>[0],
    );

    expect(source.listenerCount('SIGINT')).toBe(1);
    expect(source.listenerCount('SIGTERM')).toBe(1);
    source.emit('SIGTERM');

    await expect(waiting).resolves.toBe('SIGTERM');
    expect(source.listenerCount('SIGINT')).toBe(0);
    expect(source.listenerCount('SIGTERM')).toBe(0);
  });
});
