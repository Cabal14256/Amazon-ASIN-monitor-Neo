import { RequestMethod } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

import { ZodValidationPipe } from './common/zod-validation.pipe';

/** 注册全局 API 前缀、兼容根路由与请求校验。 */
export function configureHttpApp(app: NestFastifyApplication): void {
  app.setGlobalPrefix('api/v1', {
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: 'api/v1/health', method: RequestMethod.GET },
      { path: 'metrics', method: RequestMethod.GET },
    ],
  });
  app.useGlobalPipes(new ZodValidationPipe());
}
