import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';

import { loadEnvironmentFiles, type Env } from '@asin-monitor/config';
import { AppModule } from './app.module';
import { ENV } from './config/config.module';
import { configureHttpApp } from './http-app';
import { AppLogger } from './logger/app-logger.service';
import { runApi } from './runner';

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

  configureHttpApp(app);

  const env = app.get<Env>(ENV);
  const port = env.PORT;
  await app.listen(port, '0.0.0.0');
  logger.info(`api 服务已启动: http://0.0.0.0:${port}`, 'Bootstrap');
}

if (require.main === module) {
  loadEnvironmentFiles();
  void runApi(bootstrap);
}
