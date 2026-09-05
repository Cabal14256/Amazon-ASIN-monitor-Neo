import fastifyCookie from '@fastify/cookie';
import { RequestMethod } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { registerAuditHooks } from './audit/audit.interceptor';
import type { AuditService } from './audit/audit.service';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { ZodValidationPipe } from './common/zod-validation.pipe';
import type { HealthErrorStatsService } from './health/health.service';
import { AppLogger } from './logger/app-logger.service';
import { registerHttpMetricsHook } from './metrics/http-metrics.hook';
import type { MetricsService } from './metrics/metrics.service';
import type { RateLimitRequestHook } from './rate-limit/rate-limit.interceptor';

interface HttpAppOptions {
  audit?: AuditService;
  corsOrigin?: string;
  logger?: AppLogger;
  metrics?: MetricsService;
  errorStats?: HealthErrorStatsService;
  rateLimit?: RateLimitRequestHook;
}

/** 注册全局 API 前缀、兼容根路由与请求校验。 */
export function configureHttpApp(
  app: NestFastifyApplication,
  options: HttpAppOptions = {},
): void {
  app.enableShutdownHooks();
  if (options.audit) registerAuditHooks(app, options.audit);
  app.register(fastifyCookie);
  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'api/v1/health', method: RequestMethod.GET },
      { path: 'metrics', method: RequestMethod.GET },
    ],
  });
  app.enableCors({
    origin: options.corsOrigin ?? 'http://localhost:8000',
    credentials: true,
  });
  app.useGlobalPipes(new ZodValidationPipe());
  app.useGlobalFilters(
    new ApiExceptionFilter(
      options.logger ?? new AppLogger(),
      options.errorStats,
    ),
  );
  if (options.metrics) {
    registerHttpMetricsHook(app, options.metrics);
  }
  if (options.rateLimit) {
    const fastify = app.getHttpAdapter().getInstance();
    fastify.addHook('onRequest', async (request, reply) => {
      const blocked = await options.rateLimit!.handle(request, reply);
      if (blocked) options.errorStats?.recordStatus(429);
    });
    fastify.addHook('onResponse', async (request) => {
      options.rateLimit!.complete(request);
    });
  }
}
