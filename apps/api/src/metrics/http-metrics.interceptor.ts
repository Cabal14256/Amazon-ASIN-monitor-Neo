import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';

import { MetricsService } from './metrics.service';

interface RequestLike {
  method?: string;
  url?: string;
  routeOptions?: { url?: string };
}

interface ResponseLike {
  statusCode?: number;
  raw?: {
    statusCode?: number;
    once(event: 'finish', listener: () => void): unknown;
  };
}

@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestLike>();
    const response = http.getResponse<ResponseLike>();
    const startedAt = process.hrtime.bigint();

    response.raw?.once('finish', () => {
      const durationSeconds =
        Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
      const labels = {
        method: request.method || 'UNKNOWN',
        route: request.routeOptions?.url || 'unknown',
        status: String(response.raw?.statusCode ?? response.statusCode ?? 500),
      };
      this.metrics.httpRequestsTotal.inc(labels);
      this.metrics.httpRequestDurationSeconds.observe(labels, durationSeconds);
    });

    return next.handle();
  }
}
