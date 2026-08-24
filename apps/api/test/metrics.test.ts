import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { lastValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { HttpMetricsInterceptor } from '../src/metrics/http-metrics.interceptor';
import { MetricsService } from '../src/metrics/metrics.service';

describe('HTTP metrics interceptor', () => {
  it('沿用 legacy 的 status 标签并在每次请求后记录计数与耗时', async () => {
    const metrics = new MetricsService();
    const interceptor = new HttpMetricsInterceptor(metrics);
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'GET',
          url: '/health?verbose=1',
          routeOptions: { url: '/health' },
        }),
        getResponse: () => ({ statusCode: 200 }),
      }),
    } as unknown as ExecutionContext;
    const next = { handle: () => of({ status: 'ok' }) } as CallHandler;

    await lastValueFrom(interceptor.intercept(context, next));
    const rendered = await metrics.render();
    expect(rendered).toContain(
      'amazon_asin_monitor_http_requests_total{method="GET",route="/health",status="200"} 1',
    );
    expect(rendered).toContain(
      'amazon_asin_monitor_http_request_duration_seconds_count{method="GET",route="/health",status="200"} 1',
    );
    metrics.onModuleDestroy();
  });
});
