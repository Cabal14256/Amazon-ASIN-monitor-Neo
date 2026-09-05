import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';

import { loadEnv, loadEnvironmentFiles, type Env } from '@asin-monitor/config';
import { AppModule } from './app.module';
import { AuditService } from './audit/audit.service';
import { ENV } from './config/config.module';
import { HealthErrorStatsService } from './health/health.service';
import { configureHttpApp } from './http-app';
import { AppLogger } from './logger/app-logger.service';
import { createNestLoggerAdapter } from './logger/nest-logger.adapter';
import { MetricsService } from './metrics/metrics.service';
import { runApi } from './runner';

/**
 * 新后端入口（PROCESS_ROLE=api 角色）。
 * 与旧系统并行部署：旧 3001 / 新 3100（PORT 覆盖）。
 * 路由结构与旧系统一致：/api/v1/* 业务端点 + 根级 /health、/metrics。
 */
async function bootstrap(): Promise<void> {
  const adapterEnv = loadEnv();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      logger: false,
      ...(adapterEnv.TRUST_PROXY === undefined
        ? {}
        : { trustProxy: adapterEnv.TRUST_PROXY }),
    }),
    { bufferLogs: true },
  );

  const logger = app.get(AppLogger);
  app.useLogger(createNestLoggerAdapter(logger));

  const env = app.get<Env>(ENV);
  const metrics = app.get(MetricsService);
  const errorStats = app.get(HealthErrorStatsService);
  configureHttpApp(app, {
    audit: app.get(AuditService),
    corsOrigin: env.CORS_ORIGIN,
    logger,
    metrics,
    errorStats,
  });

  const port = env.PORT;
  await app.listen(port, '0.0.0.0');
  logger.info(`api 服务已启动: http://0.0.0.0:${port}`, 'Bootstrap');
}

if (require.main === module) {
  loadEnvironmentFiles();
  void runApi(bootstrap);
}
