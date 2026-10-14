import { createServer, request } from 'node:http';
import { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WorkerMetrics,
  startMetricsListener,
  startWorkerMetrics,
} from '../src/metrics';

const prefix = 'amazon_asin_monitor_';
const owned: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(owned.splice(0).map((resource) => resource.close()));
  vi.restoreAllMocks();
});

function get(port: number, path = '/metrics', method = 'GET') {
  return new Promise<{ status: number; type: string; body: string }>(
    (resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, method }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            type: String(res.headers['content-type'] ?? ''),
            body,
          }),
        );
      });
      req.on('error', reject);
      req.end();
    },
  );
}

describe('Worker process metrics scrape', () => {
  it('keeps separate Worker registries isolated while exposing the same Legacy names', async () => {
    const first = new WorkerMetrics();
    const second = new WorkerMetrics();
    first.recordGroup({ region: 'UK', isBroken: false, durationSec: 1 });
    first.recordRun({ type: 'monitor_task', durationSec: 1 });
    const body = await second.render();
    expect(body).not.toContain('variant_group_checks_total{');
    expect(body).not.toContain('scheduler_runs_total{');
    expect(await first.render()).toContain(
      'variant_group_checks_total{region="UK",result="ok"} 1',
    );
  });

  it('serves Legacy group/run names, labels and buckets from a real socket', async () => {
    const metrics = new WorkerMetrics();
    metrics.recordGroup({ region: 'US', isBroken: false, durationSec: 0.25 });
    metrics.recordGroup({ region: 'US', isBroken: true, durationSec: 0.75 });
    metrics.recordRun({ type: 'monitor_task', durationSec: 2 });
    metrics.recordRun({ type: 'competitor_monitor_task', durationSec: 6 });
    const listener = await startMetricsListener(metrics, '127.0.0.1', 0);
    owned.push(listener);
    const response = await get(listener.port);
    expect(response.status).toBe(200);
    expect(response.type).toBe(metrics.contentType);
    expect(response.body).toContain(
      prefix + 'variant_group_checks_total{region="US",result="ok"} 1',
    );
    expect(response.body).toContain(
      prefix + 'variant_group_checks_total{region="US",result="broken"} 1',
    );
    expect(response.body).toContain(
      prefix + 'variant_group_check_duration_seconds_count{region="US"} 2',
    );
    expect(response.body).toContain(
      prefix + 'variant_group_check_duration_seconds_sum{region="US"} 1',
    );
    for (const le of ['0.1', '0.5', '1', '2', '5', '10', '+Inf'])
      expect(response.body).toContain(
        'variant_group_check_duration_seconds_bucket{le="' +
          le +
          '",region="US"}',
      );
    for (const le of ['1', '5', '10', '30', '60', '120', '+Inf'])
      expect(response.body).toContain(
        'scheduler_run_duration_seconds_bucket{le="' +
          le +
          '",type="monitor_task"}',
      );
    expect(response.body).toContain(
      'scheduler_runs_total{type="monitor_task"} 1',
    );
    expect(response.body).toContain(
      'scheduler_runs_total{type="competitor_monitor_task"} 1',
    );
    expect(response.body).not.toMatch(/taskId|userId|isCompetitor|domain=/);
  });

  it('keeps random paths and query strings out of the metric label set, with GET-only exact route', async () => {
    const metrics = new WorkerMetrics();
    const listener = await startMetricsListener(metrics, '127.0.0.1', 0);
    owned.push(listener);
    for (const path of [
      '/missing/owner-1',
      '/missing/owner-2',
      '/metrics?owner=1',
      '/api/metrics',
    ])
      expect((await get(listener.port, path)).status).toBe(404);
    expect((await get(listener.port, '/metrics', 'HEAD')).status).toBe(405);
    const body = (await get(listener.port)).body;
    expect(body).not.toMatch(/owner|http_requests_total|route=/);
    await listener.close();
    await expect(get(listener.port)).rejects.toThrow();
  });

  it('returns a fixed error response without exposing a failed collector payload', async () => {
    const metrics = new WorkerMetrics();
    vi.spyOn(metrics, 'render').mockRejectedValue(
      new Error('token=secret-collector-payload'),
    );
    const listener = await startMetricsListener(metrics, '127.0.0.1', 0);
    owned.push(listener);
    expect(await get(listener.port)).toMatchObject({
      status: 503,
      body: 'Metrics unavailable\n',
    });
  });

  it('does not bind when disabled and fails an occupied port before business startup', async () => {
    expect(
      await startWorkerMetrics({
        WORKER_METRICS_ENABLED: false,
        WORKER_METRICS_HOST: '127.0.0.1',
        WORKER_METRICS_PORT: 3101,
      }),
    ).toBeUndefined();
    const blocker = createServer();
    await new Promise<void>((resolve) =>
      blocker.listen(0, '127.0.0.1', resolve),
    );
    owned.push({
      close: () =>
        new Promise<void>((resolve) => blocker.close(() => resolve())),
    });
    await expect(
      startWorkerMetrics({
        WORKER_METRICS_ENABLED: true,
        WORKER_METRICS_HOST: '127.0.0.1',
        WORKER_METRICS_PORT: (blocker.address() as AddressInfo).port,
      }),
    ).rejects.toThrow();
  });

  it('rejects nonfinite durations and nonallowlisted labels before changing counters', async () => {
    const metrics = new WorkerMetrics();
    metrics.recordGroup({ region: 'US', isBroken: false, durationSec: NaN });
    metrics.recordGroup({
      region: 'owner-123',
      isBroken: false,
      durationSec: 1,
    });
    metrics.recordRun({ type: 'task-123', durationSec: 1 });
    metrics.recordRun({ type: 'monitor_task', durationSec: -1 });
    const body = await metrics.render();
    expect(body).not.toContain('owner-123');
    expect(body).not.toContain('task-123');
    expect(body).not.toContain('variant_group_checks_total{');
    expect(body).not.toContain('scheduler_runs_total{');
  });
});
