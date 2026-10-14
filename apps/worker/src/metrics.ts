import type { Env } from '@asin-monitor/config';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  Counter,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';
import { logger } from './logger';

const PREFIX = 'amazon_asin_monitor_';
const REGIONS = ['US', 'UK', 'DE', 'FR', 'IT', 'ES'];
const RUN_TYPES = ['monitor_task', 'competitor_monitor_task'];

export interface MonitorMetrics {
  recordGroup(input: {
    region: string;
    isBroken: boolean;
    durationSec: number;
  }): void;
  recordRun(input: { type: string; durationSec: number }): void;
}

function warn(
  reason: 'observer_failed' | 'scrape_failed' | 'listener_failed',
): void {
  try {
    logger.warn('Worker 指标记录或抓取失败', { reason });
  } catch {
    // Observability cannot replace a business result or skip resource cleanup.
  }
}

/** Normal returns/processor attempts, not unique durable commits or SP-API calls. */
export class WorkerMetrics implements MonitorMetrics {
  readonly registry = new Registry();
  private readonly groups = new Counter({
    name: PREFIX + 'variant_group_checks_total',
    help: '变体组监控正常返回调用次数（包含缓存和 receipt 返回）',
    labelNames: ['region', 'result'] as const,
    registers: [this.registry],
  });
  private readonly groupDuration = new Histogram({
    name: PREFIX + 'variant_group_check_duration_seconds',
    help: '每次变体组监控正常返回耗时',
    labelNames: ['region'] as const,
    buckets: [0.1, 0.5, 1, 2, 5, 10],
    registers: [this.registry],
  });
  private readonly runs = new Counter({
    name: PREFIX + 'scheduler_runs_total',
    help: '有效监控 processor 执行尝试次数（包含失败、取消和重放）',
    labelNames: ['type'] as const,
    registers: [this.registry],
  });
  private readonly runDuration = new Histogram({
    name: PREFIX + 'scheduler_run_duration_seconds',
    help: '每次有效监控 processor 执行尝试耗时',
    labelNames: ['type'] as const,
    buckets: [1, 5, 10, 30, 60, 120],
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({
      register: this.registry,
      prefix: PREFIX,
      gcDurationBuckets: [0.001, 0.01, 0.1, 1, 2, 5],
    });
  }

  get contentType(): string {
    return this.registry.contentType;
  }
  render(): Promise<string> {
    return this.registry.metrics();
  }

  recordGroup(input: {
    region: string;
    isBroken: boolean;
    durationSec: number;
  }): void {
    if (
      !REGIONS.includes(input.region) ||
      typeof input.isBroken !== 'boolean' ||
      !Number.isFinite(input.durationSec) ||
      input.durationSec < 0
    )
      return;
    this.groups.inc({
      region: input.region,
      result: input.isBroken ? 'broken' : 'ok',
    });
    this.groupDuration.observe({ region: input.region }, input.durationSec);
  }

  recordRun(input: { type: string; durationSec: number }): void {
    if (
      !RUN_TYPES.includes(input.type) ||
      !Number.isFinite(input.durationSec) ||
      input.durationSec < 0
    )
      return;
    this.runs.inc({ type: input.type });
    this.runDuration.observe({ type: input.type }, input.durationSec);
  }
}

export function observeMonitorMetrics(
  metrics: MonitorMetrics | undefined,
  observe: (metrics: MonitorMetrics) => void,
): void {
  if (!metrics) return;
  try {
    observe(metrics);
  } catch {
    warn('observer_failed');
  }
}

interface MetricsRenderer {
  readonly contentType: string;
  render(): Promise<string>;
}

/** GET-only exact root route; unknown URLs never become labels or log payloads. */
export async function startMetricsListener(
  metrics: MetricsRenderer,
  host: string,
  port: number,
): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer(
    {
      maxHeaderSize: 8192,
      headersTimeout: 5000,
      requestTimeout: 5000,
      keepAliveTimeout: 1000,
    },
    (request, response) => {
      response.setHeader('Connection', 'close');
      if (request.url !== '/metrics') {
        response.writeHead(404, {
          'Content-Type': 'text/plain; charset=utf-8',
        });
        response.end('Not found\n');
        return;
      }
      if (request.method !== 'GET') {
        response.writeHead(405, {
          Allow: 'GET',
          'Content-Type': 'text/plain; charset=utf-8',
        });
        response.end('Method not allowed\n');
        return;
      }
      void Promise.resolve()
        .then(() => metrics.render())
        .then((body) => {
          if (response.destroyed) return;
          response.writeHead(200, { 'Content-Type': metrics.contentType });
          response.end(body);
        })
        .catch(() => {
          warn('scrape_failed');
          if (!response.destroyed) {
            response.writeHead(503, {
              'Content-Type': 'text/plain; charset=utf-8',
            });
            response.end('Metrics unavailable\n');
          }
        });
    },
  );
  server.maxHeadersCount = 32;
  server.on('error', () => warn('listener_failed'));
  await new Promise<void>((resolve, reject) => {
    const failed = () => reject(new Error('WORKER_METRICS_BIND_FAILED'));
    server.once('error', failed);
    server.listen(port, host, () => {
      server.removeListener('error', failed);
      resolve();
    });
  });
  let closing: Promise<void> | undefined;
  return {
    port: (server.address() as AddressInfo).port,
    close: () => {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Scrapes carry no business work. Stop active/idle sockets immediately
        // so this resource cannot hold up the existing 10s Worker shutdown.
        server.closeAllConnections();
      });
      return closing;
    },
  };
}

export interface WorkerMetricsRuntime {
  observer: MonitorMetrics;
  port: number;
  close(): Promise<void>;
}

export async function startWorkerMetrics(
  env: Pick<
    Env,
    'WORKER_METRICS_ENABLED' | 'WORKER_METRICS_HOST' | 'WORKER_METRICS_PORT'
  >,
): Promise<WorkerMetricsRuntime | undefined> {
  if (!env.WORKER_METRICS_ENABLED) return undefined;
  const metrics = new WorkerMetrics();
  try {
    const listener = await startMetricsListener(
      metrics,
      env.WORKER_METRICS_HOST,
      env.WORKER_METRICS_PORT,
    );
    try {
      logger.info('Worker 指标抓取端口已监听', { port: listener.port });
    } catch {
      warn('listener_failed');
    }
    return {
      observer: metrics,
      port: listener.port,
      close: async () => {
        await listener.close();
        metrics.registry.clear();
      },
    };
  } catch (error) {
    metrics.registry.clear();
    throw error;
  }
}
