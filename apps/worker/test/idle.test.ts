import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
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

  it('真实 Node 子进程在没有网络或输入句柄时仍保持空闲存活', async () => {
    const modulePath = resolve(__dirname, '../dist/idle.js');
    const child = spawn(
      process.execPath,
      [
        '-e',
        `void require(${JSON.stringify(
          modulePath,
        )}).waitForShutdownSignal(); process.stdout.write('idle-ready');`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolveExit) => {
      child.once('exit', (code, signal) => resolveExit({ code, signal }));
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((ready, reject) => {
        deadline = setTimeout(
          () => reject(new Error('Idle fixture did not start')),
          3000,
        );
        child.once('error', reject);
        child.once('exit', () =>
          reject(new Error('Idle fixture exited before readiness')),
        );
        child.stdout.on('data', (chunk: Buffer) => {
          if (chunk.toString('utf8').includes('idle-ready')) ready();
        });
      });
      if (deadline) clearTimeout(deadline);
      await new Promise((wait) => setTimeout(wait, 250));
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      child.kill('SIGTERM');
      const outcome = await exited;
      if (process.platform !== 'win32')
        expect(outcome).toEqual({ code: 0, signal: null });
    } finally {
      if (deadline) clearTimeout(deadline);
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGTERM');
      await exited;
    }
  }, 5000);
});
