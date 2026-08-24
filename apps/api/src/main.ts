import 'reflect-metadata';

import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';

import { AppModule } from './app.module';
import { ZodValidationPipe } from './common/zod-validation.pipe';
import { AppLogger } from './logger/app-logger.service';

/**
 * 新后端入口（PROCESS_ROLE=api 角色）。
 * 与旧系统并行部署：旧 3001 / 新 3100（PORT 覆盖）。
 * 路由结构与旧系统一致：/api/v1/* 业务端点 + 根级 /health、/metrics。
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false }),
    { bufferLogs: true },
  );

  const logger = app.get(AppLogger);
  app.useLogger({
    log: (m, c) => logger.info(m, c),
    error: (m, c) => logger.error(m, c),
    warn: (m, c) => logger.warn(m, c),
    debug: (m, c) => logger.debug(m, c),
    verbose: (m, c) => logger.debug(m, c),
    fatal: (m, c) => logger.error(m, c),
  });

  app.setGlobalPrefix('api/v1', { exclude: ['/health', '/metrics'] });
  app.useGlobalPipes(
    new ZodValidationPipe(),
    new ValidationPipe({ transform: true }),
  );

  const port = Number(process.env.PORT ?? 3100);
  await app.listen(port, '0.0.0.0');
  logger.info(`api 服务已启动: http://0.0.0.0:${port}`, 'Bootstrap');
}

void bootstrap();
