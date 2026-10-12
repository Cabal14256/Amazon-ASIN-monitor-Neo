import type { Env } from '@asin-monitor/config';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { availableMetricsPort } from './helpers/metrics-fixture';

const controls = vi.hoisted(() => ({
  env: {} as Env,
  wait: vi.fn(),
  start: vi.fn(),
  metrics: undefined as { close(): Promise<void> } | undefined,
}));
vi.mock('@asin-monitor/config', async (original) => ({
  ...(await original<typeof import('@asin-monitor/config')>()),
  loadEnvironmentFiles: vi.fn(),
  loadEnv: () => controls.env,
}));
vi.mock('../src/idle', () => ({ waitForShutdownSignal: controls.wait }));
vi.mock('../src/variant-check-runtime', () => ({
  startVariantCheckRuntime: controls.start,
}));
vi.mock('../src/metrics', async (original) => {
  const actual = await original<typeof import('../src/metrics')>();
  return {
    ...actual,
    startWorkerMetrics: async (
      env: Parameters<typeof actual.startWorkerMetrics>[0],
    ) => {
      const metrics = await actual.startWorkerMetrics(env);
      controls.metrics = metrics;
      return metrics;
    },
  };
});
vi.mock('bullmq', async (original) => ({
  ...(await original<typeof import('bullmq')>()),
  Queue: class {
    on() {
      return this;
    }
    async close() {}
    async getJobCounts() {
      return {};
    }
  },
}));
vi.mock('ioredis', async (original) => ({
  ...(await original<typeof import('ioredis')>()),
  Redis: class {
    on() {
      return this;
    }
    async quit() {}
  },
}));
vi.mock('../src/watchdog', () => ({
  createSingleFlightCheck: (check: unknown) => check,
  RedisWatchdog: class {
    start() {}
    stop() {}
  },
}));

import { bootstrap } from '../src/main';

beforeEach(async () => {
  controls.metrics = undefined;
  controls.start.mockReset();
  controls.wait.mockReset().mockResolvedValue('SIGTERM');
  const actual = await vi.importActual<typeof import('@asin-monitor/config')>(
    '@asin-monitor/config',
  );
  controls.env = actual.loadEnv({
    DATABASE_URL: 'postgresql://localhost/amazon_asin_monitor_ci',
    COMPETITOR_DATABASE_URL:
      'postgresql://localhost/amazon_competitor_monitor_ci',
    REDIS_URL: 'redis://localhost:6379/15',
    JWT_SECRET: 'local-fixture-only',
    AUTH_DATA_AUTHORITY: 'postgresql',
    WORKER_ENABLED_QUEUES: 'off',
    WORKER_METRICS_ENABLED: 'true',
    WORKER_METRICS_PORT: String(await availableMetricsPort()),
  });
});
afterEach(async () => {
  await controls.metrics?.close();
  vi.restoreAllMocks();
});
const scrape = () =>
  fetch('http://127.0.0.1:' + controls.env.WORKER_METRICS_PORT + '/metrics');

describe('Worker owned metrics lifecycle', () => {
  it('leaves disabled idle mode without a metrics resource or business runtime', async () => {
    controls.env.WORKER_METRICS_ENABLED = false;
    await bootstrap();
    expect(controls.metrics).toBeUndefined();
    expect(controls.start).not.toHaveBeenCalled();
    await expect(scrape()).rejects.toThrow();
  });
  it('scrapes enabled idle without Redis business startup and closes on its stopping signal', async () => {
    controls.wait.mockImplementationOnce(async () => {
      expect((await scrape()).status).toBe(200);
      return 'SIGTERM';
    });
    await bootstrap();
    expect(controls.start).not.toHaveBeenCalled();
    await expect(scrape()).rejects.toThrow();
  });
  it('refuses a bind collision before any selected business consumer starts', async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(0, '127.0.0.1', resolve),
    );
    try {
      controls.env.WORKER_ENABLED_QUEUES = 'monitor';
      controls.env.WORKER_METRICS_PORT = (
        blocker.address() as AddressInfo
      ).port;
      await expect(bootstrap()).rejects.toThrow('WORKER_METRICS_BIND_FAILED');
      expect(controls.start).not.toHaveBeenCalled();
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
  it('closes its already-bound listener when later startup fails', async () => {
    controls.wait.mockImplementationOnce(async () => {
      expect((await scrape()).status).toBe(200);
      throw new Error('startup interrupted');
    });
    await expect(bootstrap()).rejects.toThrow('startup interrupted');
    await expect(scrape()).rejects.toThrow();
  });
  it('keeps Legacy authority out of Neo consumers and closes active metrics within shared shutdown', async () => {
    controls.env.AUTH_DATA_AUTHORITY = 'legacy-mysql';
    controls.env.WORKER_ENABLED_QUEUES = 'monitor';
    const signals = new Map<string, () => void>();
    const on = process.on.bind(process);
    vi.spyOn(process, 'on').mockImplementation(((
      event: string,
      listener: () => void,
    ) => {
      if (event === 'SIGTERM' || event === 'SIGINT') {
        signals.set(event, listener);
        return process;
      }
      return on(event, listener);
    }) as typeof process.on);
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never);
    await bootstrap();
    expect((await scrape()).status).toBe(200);
    expect(controls.start).not.toHaveBeenCalled();
    signals.get('SIGTERM')!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    await expect(scrape()).rejects.toThrow();
  });
});
