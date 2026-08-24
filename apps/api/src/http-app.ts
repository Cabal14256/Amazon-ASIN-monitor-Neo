import { RequestMethod } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { ApiExceptionFilter } from './common/api-exception.filter';
import { ZodValidationPipe } from './common/zod-validation.pipe';
import { AppLogger } from './logger/app-logger.service';

interface HttpAppOptions {
  corsOrigin?: string;
  logger?: AppLogger;
}

/** 注册全局 API 前缀、兼容根路由与请求校验。 */
export function configureHttpApp(
  app: NestFastifyApplication,
  options: HttpAppOptions = {},
): void {
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
    new ApiExceptionFilter(options.logger ?? new AppLogger()),
  );
}
