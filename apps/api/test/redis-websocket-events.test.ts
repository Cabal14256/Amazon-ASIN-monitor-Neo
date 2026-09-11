import { loadEnv } from '@asin-monitor/config';
import { createServer, type Socket } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { AppLogger } from '../src/logger/app-logger.service';
import { RedisWebSocketEventBus } from '../src/websocket/redis-websocket-events';

describe('task subscription connection lifecycle', () => {
  it('starts lazily, bounds stalled handshakes, reconnects and releases sockets/timers at shutdown', async () => {
    const sockets = new Set<Socket>();
    let accepted = 0;
    const server = createServer((socket) => {
      accepted++;
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('data', () => undefined); // Accept TCP but never acknowledge Redis commands.
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Fixture address missing');
    const env = loadEnv({
      DATABASE_URL: 'postgresql://localhost/fixture',
      COMPETITOR_DATABASE_URL: 'postgresql://localhost/fixture_competitor',
      REDIS_URL: `redis://127.0.0.1:${address.port}`,
      JWT_SECRET: 'fixture-secret',
      AUTH_DATA_AUTHORITY: 'postgresql',
    });
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const bus = new RedisWebSocketEventBus(env, logger as unknown as AppLogger);
    const listener = vi.fn();
    try {
      expect(bus['reader']).toBeUndefined();
      expect(accepted).toBe(0);
      const unsubscribe = bus.subscribe(listener);
      await vi.waitFor(() => expect(accepted).toBeGreaterThanOrEqual(4), {
        timeout: 6000,
        interval: 20,
      });
      expect(sockets.size).toBeLessThanOrEqual(2);
      expect(listener).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledOnce();
      expect(bus['reader']!['offlineQueue'].length).toBe(0);
      expect(bus['subscriber']!['offlineQueue'].length).toBe(0);
      unsubscribe();
      bus.onModuleDestroy();
      await vi.waitFor(() => expect(sockets.size).toBe(0));
      expect(bus['readyTimers'].size).toBe(0);
      expect(() => bus.subscribe(listener)).toThrow('TASK_EVENT_BUS_CLOSED');
      const count = accepted;
      await new Promise((resolve) => setTimeout(resolve, 1200));
      expect(accepted).toBe(count);
      expect(bus['reader']!.status).toBe('end');
      expect(bus['subscriber']!.status).toBe('end');
    } finally {
      bus.onModuleDestroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10000);
});
