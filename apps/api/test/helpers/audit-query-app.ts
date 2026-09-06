import { loadEnv } from '@asin-monitor/config';
import type {
  AuditQueryRepositoryPort,
  AuthDataRepository,
} from '@asin-monitor/db';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import jwt from 'jsonwebtoken';
import { vi } from 'vitest';
import { AUDIT_QUERY_REPOSITORY } from '../../src/audit/audit-query.service';
import { AuditModule } from '../../src/audit/audit.module';
import { AUTH_DATA_REPOSITORY } from '../../src/auth/auth.constants';
import { ENV } from '../../src/config/config.module';
import { configureHttpApp } from '../../src/http-app';
import { AppLogger } from '../../src/logger/app-logger.service';
import { ApplicationRedisClient } from '../../src/redis/redis.service';

export async function auditQueryApp(queries: AuditQueryRepositoryPort) {
  const env = loadEnv({
    DATABASE_URL: 'postgresql://localhost/audit_query_fixture',
    COMPETITOR_DATABASE_URL: 'postgresql://localhost/audit_competitor_fixture',
    REDIS_URL: 'redis://localhost:6379/15',
    JWT_SECRET: 'audit-query-test-fixture',
    AUTH_DATA_AUTHORITY: 'postgresql',
  });
  const userId = 'audit-query-fixture-user';
  const sessionId = '00000000-0000-0000-0000-000000000041';
  const auth = {
    findSessionById: vi.fn().mockResolvedValue({
      id: sessionId,
      userId,
      status: 'ACTIVE',
      expiresAt: new Date('2099-01-01T00:00:00Z'),
    }),
    findUserById: vi.fn().mockResolvedValue({
      id: userId,
      username: 'fixture',
      status: 'ACTIVE',
      forcePasswordChange: false,
      passwordExpiresAt: new Date('2099-01-01T00:00:00Z'),
    }),
    revokeSession: vi.fn(),
    touchSession: vi.fn(),
    markPasswordChangeRequired: vi.fn(),
    getPermissionCodes: vi.fn().mockResolvedValue(['audit:read']),
    getRoles: vi
      .fn()
      .mockResolvedValue([
        { id: 'fixture-role', code: 'READONLY', name: 'Fixture' },
      ]),
  };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const moduleRef = await Test.createTestingModule({
    imports: [AuditModule],
  })
    .overrideProvider(ENV)
    .useValue(env)
    .overrideProvider(AUTH_DATA_REPOSITORY)
    .useValue(auth as unknown as AuthDataRepository)
    .overrideProvider(AUDIT_QUERY_REPOSITORY)
    .useValue(queries)
    .overrideProvider(AppLogger)
    .useValue(logger)
    .overrideProvider(ApplicationRedisClient)
    .useValue({
      get: vi.fn().mockResolvedValue(null),
      setex: vi.fn(),
      del: vi.fn(),
    })
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter({ logger: false }),
  );
  configureHttpApp(app, { logger: logger as unknown as AppLogger });
  await app.init();
  const http = app.getHttpAdapter().getInstance();
  await http.ready();
  const headers = {
    authorization: `Bearer ${jwt.sign({ userId, sessionId }, env.JWT_SECRET, {
      expiresIn: '1h',
    })}`,
  };
  return { app, http, auth, logger, headers };
}
