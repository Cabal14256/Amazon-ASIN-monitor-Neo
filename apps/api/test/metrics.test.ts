import {
  Controller,
  Get,
  Param,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureHttpApp } from '../src/http-app';
import { MetricsController } from '../src/metrics/metrics.controller';
import { MetricsService } from '../src/metrics/metrics.service';

@Controller('metric-probe')
class MetricProbeController {
  @Get('unavailable')
  unavailable(): never {
    throw new ServiceUnavailableException('temporarily unavailable');
  }

  @Get(':id')
  get(@Param('id') id: string): { id: string } {
    return { id };
  }
}

describe('Fastify HTTP metrics hook', () => {
  let app: NestFastifyApplication;
  let metrics: MetricsService;

  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    metrics = new MetricsService();
    const moduleRef = await Test.createTestingModule({
      controllers: [MetricProbeController, MetricsController],
      providers: [{ provide: MetricsService, useValue: metrics }],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ logger: false }),
    );
    configureHttpApp(app, { metrics });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    metrics.onModuleDestroy();
  });

  it('沿用 legacy status 标签并按已匹配的路由模板记录', async () => {
    await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/api/v1/metric-probe/123',
    });

    const rendered = await metrics.render();
    expect(rendered).toContain(
      'amazon_asin_monitor_http_requests_total{method="GET",route="/api/v1/metric-probe/:id",status="200"} 1',
    );
    expect(rendered).toContain(
      'amazon_asin_monitor_http_request_duration_seconds_count{method="GET",route="/api/v1/metric-probe/:id",status="200"} 1',
    );
  });

  it('onResponse 读取异常过滤器写入的最终状态码', async () => {
    await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/api/v1/metric-probe/unavailable',
    });

    const rendered = await metrics.render();
    expect(rendered).toContain(
      'amazon_asin_monitor_http_requests_total{method="GET",route="/api/v1/metric-probe/unavailable",status="503"} 1',
    );
    expect(rendered).not.toContain('status="200"');
  });

  it('真实未匹配路径统一折叠为 unknown，避免标签基数失控', async () => {
    const fastify = app.getHttpAdapter().getInstance();
    await fastify.inject({ method: 'GET', url: '/scan/unique-1' });
    await fastify.inject({ method: 'GET', url: '/scan/unique-2' });

    const rendered = await metrics.render();
    expect(rendered).toContain(
      'amazon_asin_monitor_http_requests_total{method="GET",route="unknown",status="404"} 2',
    );
    expect(rendered).not.toContain('/scan/unique-');
  });

  it('/metrics 返回 Registry 声明的 Prometheus exposition content type', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/metrics',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe(metrics.contentType);
    expect(response.body).toContain(
      '# HELP amazon_asin_monitor_http_requests_total HTTP 请求总数',
    );
  });

  it('当前限流后端以 one-hot gauge 暴露且切换时不保留旧状态', async () => {
    metrics.setRateLimitBackend('memory');
    let rendered = await metrics.render();
    expect(rendered).toContain(
      'amazon_asin_monitor_http_rate_limit_backend_active{backend="memory"} 1',
    );
    expect(rendered).toContain(
      'amazon_asin_monitor_http_rate_limit_backend_active{backend="redis"} 0',
    );

    metrics.setRateLimitBackend('redis');
    rendered = await metrics.render();
    expect(rendered).toContain(
      'amazon_asin_monitor_http_rate_limit_backend_active{backend="memory"} 0',
    );
    expect(rendered).toContain(
      'amazon_asin_monitor_http_rate_limit_backend_active{backend="redis"} 1',
    );
  });
});
