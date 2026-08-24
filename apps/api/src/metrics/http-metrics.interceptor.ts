import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';

import { MetricsService } from './metrics.service';

interface RequestLike {
  method?: string;
  url?: string;
  routeOptions?: { url?: string };
}

interface ResponseLike {
  statusCode?: number;
}

@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const request = http.getRequest<RequestLike>();
    const response = http.getResponse<ResponseLike>();
    const startedAt = process.hrtime.bigint();

    return next.handle().pipe(
      finalize(() => {
        const durationSeconds =
          Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
        const labels = {
          method: request.method || 'UNKNOWN',
          route:
            request.routeOptions?.url ||
            request.url?.split('?')[0] ||
            'unknown',
          status: String(response.statusCode ?? 500),
        };
        this.metrics.httpRequestsTotal.inc(labels);
        this.metrics.httpRequestDurationSeconds.observe(
          labels,
          durationSeconds,
        );
      }),
    );
  }
}
