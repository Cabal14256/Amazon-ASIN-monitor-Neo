import { loadEnv } from '@asin-monitor/config';
import { updateProfileResultSchema } from '@asin-monitor/contracts';
import {
  PgAccountRepository,
  type AccountRepositoryPort,
} from '@asin-monitor/db';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AuditModule } from '../src/audit/audit.module';
import { AuditService } from '../src/audit/audit.service';
import {
  ACCOUNT_REPOSITORY,
  hashPassword,
  PASSWORD_HASHER,
} from '../src/auth/account.service';
import { AuthModule } from '../src/auth/auth.module';
import { ENV } from '../src/config/config.module';
import { ApplicationDatabasePools } from '../src/database/database.service';
import { configureHttpApp } from '../src/http-app';
import { AppLogger } from '../src/logger/app-logger.service';
import { ApplicationRedisClient } from '../src/redis/redis.service';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'Neo account atomic writes / real PostgreSQL',
  () => {
    let app: NestFastifyApplication;
    let pools: ApplicationDatabasePools;
    let repository: AccountRepositoryPort;
    let audit: AuditService;
    const ids: string[] = [];
    const original = 'Fixture-Account-Original-53';
    const replacement = 'Fixture-Account-Replacement-53';
    let originalHash: string;
    const hasher = vi.fn(hashPassword);
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const env = () => ({
      ...loadEnv(process.env),
      AUTH_DATA_AUTHORITY: 'postgresql' as const,
    });

    beforeAll(async () => {
      originalHash = await bcrypt.hash(original, 10);
      const moduleRef = await Test.createTestingModule({
        imports: [AuthModule, AuditModule],
      })
        .overrideProvider(ENV)
        .useValue(env())
        .overrideProvider(AppLogger)
        .useValue(logger)
        .overrideProvider(PASSWORD_HASHER)
        .useValue(hasher)
        .overrideProvider(ApplicationRedisClient)
        .useValue({
          get: async () => null,
          setex: async () => undefined,
          del: async () => 0,
        })
        .compile();
      app = moduleRef.createNestApplication<NestFastifyApplication>(
        new FastifyAdapter({ logger: false }),
      );
      pools = app.get(ApplicationDatabasePools);
      repository = app.get(ACCOUNT_REPOSITORY);
      expect(repository).toBeInstanceOf(PgAccountRepository);
      audit = app.get(AuditService);
      vi.spyOn(audit, 'record');
      configureHttpApp(app, { logger: logger as unknown as AppLogger, audit });
      await app.init();
      await app.getHttpAdapter().getInstance().ready();
    });
    afterAll(async () => {
      try {
        if (audit) await audit.flush();
        if (pools && ids.length) {
          await pools.primaryPool.query(
            'DELETE FROM audit_logs WHERE user_id = ANY($1::text[])',
            [ids],
          );
          await pools.primaryPool.query(
            'DELETE FROM users WHERE id = ANY($1::text[])',
            [ids],
          );
        }
      } finally {
        vi.restoreAllMocks();
        if (app) await app.close();
      }
    });
    async function fixture() {
      const id = `a53-${randomUUID()}`;
      ids.push(id);
      await pools.primaryPool.query(
        `INSERT INTO users (id, username, password, real_name, force_password_change, password_expires_at) VALUES ($1, $1, $2, 'Fixture original', true, '2000-01-01 08:00:00')`,
        [id, originalHash],
      );
      const current = randomUUID();
      const other = randomUUID();
      await pools.primaryPool.query(
        `INSERT INTO sessions (id, user_id, expires_at) VALUES ($1, $3, '2099-01-01 08:00:00'), ($2, $3, '2099-01-01 08:00:00')`,
        [current, other, id],
      );
      const headers = {
        authorization: `Bearer ${jwt.sign(
          { userId: id, sessionId: current },
          env().JWT_SECRET,
          { expiresIn: '1h' },
        )}`,
      };
      const request = (method: 'POST' | 'PUT', path: string, payload: object) =>
        app
          .getHttpAdapter()
          .getInstance()
          .inject({ method, url: `/api/v1/auth/${path}`, headers, payload });
      return {
        id,
        current,
        other,
        headers,
        profile: (payload: object) => request('PUT', 'profile', payload),
        change: (newPassword = replacement, revokeOtherSessions = true) =>
          request('POST', 'change-password', {
            oldPassword: original,
            newPassword,
            revokeOtherSessions,
          }),
      };
    }
    const stored = async (id: string) =>
      (await pools.primaryPool.query('SELECT * FROM users WHERE id = $1', [id]))
        .rows[0];
    const histories = async (id: string) =>
      (
        await pools.primaryPool.query(
          'SELECT id, password_hash FROM password_history WHERE user_id = $1 ORDER BY created_at DESC NULLS LAST, id DESC',
          [id],
        )
      ).rows;
    const sessionStates = async (id: string) =>
      (
        await pools.primaryPool.query(
          'SELECT id, status FROM sessions WHERE user_id = $1 ORDER BY id',
          [id],
        )
      ).rows;

    it('persists only own profile fields, leaves credentials untouched, and audits the authenticated owner', async () => {
      const f = await fixture();
      const foreign = await fixture();
      const response = await f.profile({
        real_name: '😀'.repeat(100),
        userId: foreign.id,
        password: 'injected',
        status: 'SUSPENDED',
      });
      expect(response.statusCode).toBe(200);
      expect(
        updateProfileResultSchema.parse(response.json()).data!.user,
      ).toMatchObject({
        id: f.id,
        real_name: '😀'.repeat(100),
        status: 'ACTIVE',
      });
      expect(await stored(f.id)).toMatchObject({
        password: originalHash,
        status: 'ACTIVE',
        force_password_change: true,
        real_name: '😀'.repeat(100),
      });
      expect((await stored(foreign.id)).real_name).toBe('Fixture original');
      await vi.waitFor(() =>
        expect(
          vi
            .mocked(audit.record)
            .mock.calls.some(
              ([entry]) =>
                entry.userId === f.id && entry.action === 'UPDATE_PROFILE',
            ),
        ).toBe(true),
      );
      await audit.flush();
      const entries = (
        await pools.primaryPool.query(
          "SELECT * FROM audit_logs WHERE user_id=$1 AND action='UPDATE_PROFILE'",
          [f.id],
        )
      ).rows;
      expect(entries).toHaveLength(1);
      expect(entries[0].response_status).toBe(200);
      expect(JSON.stringify(entries)).not.toContain('injected');
    });
    it('rejects recent reuse and atomically prunes to five, clears forced change and revokes other sessions', async () => {
      const f = await fixture();
      const previous = await Promise.all(
        Array.from({ length: 7 }, (_, i) =>
          bcrypt.hash(`Fixture-Previous-${i}-53`, 4),
        ),
      );
      for (let i = 0; i < previous.length; i++) {
        if (i === 6) {
          const historyId =
            8_000_000_000_000_000_000n +
            BigInt(`0x${randomUUID().replace(/-/g, '').slice(0, 10)}`);
          await pools.primaryPool.query(
            'INSERT INTO password_history (id, user_id, password_hash, created_at) OVERRIDING SYSTEM VALUE VALUES ($1, $2, $3, $4)',
            [historyId.toString(), f.id, previous[i], '2001-01-01 08:00:00'],
          );
          continue;
        }
        await pools.primaryPool.query(
          'INSERT INTO password_history (user_id, password_hash, created_at) VALUES ($1, $2, $3)',
          [f.id, previous[i], i === 0 ? null : '2001-01-01 08:00:00'],
        );
      }
      expect((await f.change('Fixture-Previous-6-53')).statusCode).toBe(400);
      expect((await histories(f.id)).length).toBe(7);
      const foreign = await fixture();
      const before = Date.now();
      const response = await f.change();
      expect(response.statusCode).toBe(200);
      const user = await stored(f.id);
      expect(await bcrypt.compare(replacement, user.password)).toBe(true);
      expect(bcrypt.getRounds(user.password)).toBe(10);
      expect(user.force_password_change).toBe(false);
      // SQL checks local wall-clock values against the real instant, independent of the Node host timezone.
      const timing = (
        await pools.primaryPool.query(
          `SELECT extract(epoch from password_changed_at AT TIME ZONE 'Asia/Shanghai')*1000 AS changed, extract(epoch from password_expires_at-password_changed_at)/86400 AS days FROM users WHERE id=$1`,
          [f.id],
        )
      ).rows[0];
      expect(Number(timing.changed)).toBeGreaterThanOrEqual(before);
      expect(Number(timing.changed)).toBeLessThanOrEqual(Date.now());
      expect(Number(timing.days)).toBe(env().PASSWORD_EXPIRE_DAYS);
      const history = await histories(f.id);
      expect(history.map((row) => row.password_hash)).toEqual([
        originalHash,
        previous[6],
        previous[5],
        previous[4],
        previous[3],
      ]);
      expect(history.every((row) => typeof row.id === 'string')).toBe(true);
      expect(await sessionStates(f.id)).toEqual(
        expect.arrayContaining([
          { id: f.current, status: 'ACTIVE' },
          { id: f.other, status: 'REVOKED' },
        ]),
      );
      expect(
        (await sessionStates(foreign.id)).every(
          (row) => row.status === 'ACTIVE',
        ),
      ).toBe(true);
      await audit.flush();
      const entries = (
        await pools.primaryPool.query(
          "SELECT * FROM audit_logs WHERE user_id=$1 AND action='CHANGE_PASSWORD' ORDER BY response_status",
          [f.id],
        )
      ).rows;
      expect(entries.map((row) => row.response_status)).toEqual([200, 400]);
      for (const sensitive of [original, replacement, originalHash])
        expect(JSON.stringify(entries)).not.toContain(sensitive);
      const current = await app.getHttpAdapter().getInstance().inject({
        method: 'GET',
        url: '/api/v1/auth/current-user',
        headers: f.headers,
      });
      expect(current.statusCode).toBe(200);
      expect(current.json().data.mustChangePassword).toBe(false);
    });
    it('serializes concurrent changes so only one request can use the old credential', async () => {
      const f = await fixture();
      const candidates = [replacement, 'Fixture-Alternative-53'];
      const results = await Promise.all(
        candidates.map((value) => f.change(value, false)),
      );
      expect(results.map((response) => response.statusCode).sort()).toEqual([
        200, 400,
      ]);
      const winner = results.findIndex(
        (response) => response.statusCode === 200,
      );
      expect(
        await bcrypt.compare(candidates[winner], (await stored(f.id)).password),
      ).toBe(true);
      expect(await histories(f.id)).toHaveLength(1);
      expect(
        (await sessionStates(f.id)).every((row) => row.status === 'ACTIVE'),
      ).toBe(true);
    });
    it('rolls back history, password policy and session revocation together after a late failure', async () => {
      const f = await fixture();
      const originalTransaction = repository.transaction.bind(repository);
      const spy = vi
        .spyOn(repository, 'transaction')
        .mockImplementation((operation) =>
          originalTransaction((unit) =>
            operation({
              ...unit,
              lockUser: unit.lockUser.bind(unit),
              lockSession: unit.lockSession.bind(unit),
              recentPasswords: unit.recentPasswords.bind(unit),
              savePreviousPassword: unit.savePreviousPassword.bind(unit),
              updatePassword: unit.updatePassword.bind(unit),
              updateProfile: unit.updateProfile.bind(unit),
              access: unit.access.bind(unit),
              revokeOtherSessions: async (...args) => {
                await unit.revokeOtherSessions(...args);
                throw new Error('fixture transaction failure');
              },
            }),
          ),
        );
      try {
        expect((await f.change()).statusCode).toBe(500);
      } finally {
        spy.mockRestore();
      }
      expect(await stored(f.id)).toMatchObject({
        password: originalHash,
        force_password_change: true,
        password_changed_at: null,
      });
      expect(await histories(f.id)).toHaveLength(0);
      expect(
        (await sessionStates(f.id)).every((row) => row.status === 'ACTIVE'),
      ).toBe(true);
    });
    it('cannot write after the HTTP transaction deadline while a password hash is still pending', async () => {
      const f = await fixture();
      let release!: (value: string) => void;
      const pending = new Promise<string>((resolve) => {
        release = resolve;
      });
      hasher.mockImplementationOnce(() => pending);
      try {
        expect((await f.change()).statusCode).toBe(500);
      } finally {
        release(originalHash);
      }
      await new Promise((resolve) => setImmediate(resolve));
      expect((await stored(f.id)).password).toBe(originalHash);
      expect(await histories(f.id)).toHaveLength(0);
      expect(
        (await sessionStates(f.id)).every((row) => row.status === 'ACTIVE'),
      ).toBe(true);
    });
  },
);
