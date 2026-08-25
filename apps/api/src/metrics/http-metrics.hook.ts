import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FastifyRequest } from 'fastify';

import type { MetricsService } from './metrics.service';

const REQUEST_STARTED_AT = Symbol('httpMetricsStartedAt');
type MetricsRequest = FastifyRequest & {
  [REQUEST_STARTED_AT]?: bigint;
};

function normalizeRouteLabel(routeTemplate: string | undefined): string {
  if (!routeTemplate || routeTemplate === '*' || routeTemplate === '/*') {
    return 'unknown';
  }
  return routeTemplate;
}

/** Fastify 全局 hook 可覆盖路由命中前的请求，因此真实 404 也会进入指标。 */
export function registerHttpMetricsHook(
  app: NestFastifyApplication,
  metrics: MetricsService,
): void {
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onRequest', async (request) => {
    (request as MetricsRequest)[REQUEST_STARTED_AT] = process.hrtime.bigint();
  });
  fastify.addHook('onResponse', async (request, reply) => {
    const startedAt = (request as MetricsRequest)[REQUEST_STARTED_AT];
    if (startedAt === undefined) return;
    const durationSeconds =
      Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
    const labels = {
      method: request.method || 'UNKNOWN',
      route: normalizeRouteLabel(request.routeOptions?.url),
      status: String(reply.statusCode),
    };
    metrics.httpRequestsTotal.inc(labels);
    metrics.httpRequestDurationSeconds.observe(labels, durationSeconds);
  });
}
