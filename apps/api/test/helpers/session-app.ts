import { loadEnv } from '@asin-monitor/config';
import type {
  AuthDataRepository,
  SessionManagementRepositoryPort,
} from '@asin-monitor/db';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { vi } from 'vitest';
import { AUTH_DATA_REPOSITORY } from '../../src/auth/auth.constants';
import { AuthModule } from '../../src/auth/auth.module';
import { ENV } from '../../src/config/config.module';
import { configureHttpApp } from '../../src/http-app';
import { AppLogger } from '../../src/logger/app-logger.service';
import { ApplicationRedisClient } from '../../src/redis/redis.service';

export async function sessionApp(
  repository?: AuthDataRepository & SessionManagementRepositoryPort,
  overrides: NodeJS.ProcessEnv = {},
) {
  const env = loadEnv({
    DATABASE_URL: 'postgresql://localhost/session_fixture',
    COMPETITOR_DATABASE_URL:
      'postgresql://localhost/session_competitor_fixture',
    REDIS_URL: 'redis://localhost:6379/15',
    JWT_SECRET: 'session-test-fixture-key-with-more-than-32-characters',
    AUTH_DATA_AUTHORITY: 'postgresql',
    ...overrides,
  });
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  let builder = Test.createTestingModule({ imports: [AuthModule] })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(AppLogger)
    .useValue(logger)
    .overrideProvider(ApplicationRedisClient)
    .useValue({
      get: vi.fn().mockResolvedValue(null),
      setex: vi.fn(),
      del: vi.fn(),
    });
  if (repository)
    builder = builder
      .overrideProvider(AUTH_DATA_REPOSITORY)
      .useValue(repository);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ logger: false }),
  );
  configureHttpApp(app, { logger: logger as unknown as AppLogger });
  await app.init();
  const http = app.getHttpAdapter().getInstance();
  await http.ready();
  return { app, http, env, logger };
}
