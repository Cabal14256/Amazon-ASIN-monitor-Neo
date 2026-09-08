import { loadEnv } from '@asin-monitor/config';
import type { AddressInfo } from 'node:net';
import { createServer, type Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { AppLogger } from '../src/logger/app-logger.service';
import { TaskQueryRuntime } from '../src/tasks/task-query.runtime';

describe('task request Redis lifetime / real loopback transport', () => {
  it('fails a silent Redis peer in bounded time and closes every socket', async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const env = loadEnv({
      DATABASE_URL: 'postgresql://localhost/task_fixture',
      COMPETITOR_DATABASE_URL: 'postgresql://localhost/task_competitor_fixture',
      REDIS_URL: `redis://127.0.0.1:${(server.address() as AddressInfo).port}`,
      AUTH_DATA_AUTHORITY: 'postgresql',
      JWT_SECRET: 'unused-fixture-key-95',
    });
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const runtime = new TaskQueryRuntime(env, logger as unknown as AppLogger);
    const started = performance.now();
    try {
      await expect(
        runtime.open(() => undefined).store.read('task-95'),
      ).rejects.toThrow();
      expect(performance.now() - started).toBeLessThan(3000);
      expect(JSON.stringify(logger)).not.toContain('127.0.0.1');
      await runtime.onModuleDestroy();
      await expect(
        runtime.open(() => undefined).findJob('task-95'),
      ).rejects.toThrow('TASK_RUNTIME_CLOSED');
    } finally {
      await runtime.onModuleDestroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }, 6000);
});
