import {
  spApiConfigRecordSchema,
  spApiDisplayConfigSchema,
} from '@asin-monitor/contracts';
import {
  PgSpApiConfigurationRepository,
  type SpApiConfigurationRepositoryPort,
} from '@asin-monitor/db';
import {
  SpApiClient,
  type HttpInput,
  type QuotaExecutor,
} from '@asin-monitor/sp-api';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ApplicationSpApiConfigSource } from '../src/sp-api-config/sp-api-config.module';
import { SP_API_CONFIG_REPOSITORY } from '../src/sp-api-config/sp-api-config.service';
import { spApiConfigApp } from './helpers/sp-api-config-app';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'SP-API configuration / real PostgreSQL and Redis',
  () => {
    let f: Awaited<ReturnType<typeof spApiConfigApp>>;
    let repository: SpApiConfigurationRepositoryPort;
    let operatorId: string;
    let headers: { authorization: string };
    const secretKey = 'SP_API_LWA_CLIENT_SECRET';
    const secret = 'fixture-private-config-71';
    beforeAll(async () => {
      f = await spApiConfigApp();
      repository = f.app.get(SP_API_CONFIG_REPOSITORY);
      expect(repository).toBeInstanceOf(PgSpApiConfigurationRepository);
    });
    afterAll(async () => {
      try {
        if (f) await f.close();
      } finally {
        vi.restoreAllMocks();
      }
    });
    async function user(role = 'writer-71') {
      const userId = randomUUID(),
        sessionId = randomUUID();
      f.userIds.add(userId);
      await f.pools.primaryPool.query(
        'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$2,$3,false)',
        [userId, `u71-${userId}`, 'fixture-unused-hash'],
      );
      await f.pools.primaryPool.query(
        'INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)',
        [userId, role],
      );
      await f.pools.primaryPool.query(
        "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,'2099-01-01 08:00:00')",
        [sessionId, userId],
      );
      return {
        userId,
        headers: {
          authorization: `Bearer ${jwt.sign(
            { userId, sessionId },
            f.env.JWT_SECRET,
            { expiresIn: '1h' },
          )}`,
        },
      };
    }
    beforeEach(async () => {
      await f.pools.primaryPool.query('DELETE FROM sp_api_config');
      const operator = await user();
      operatorId = operator.userId;
      headers = operator.headers;
    });
    const write = (configs = [{ configKey: secretKey, configValue: secret }]) =>
      f.http.inject({
        method: 'PUT',
        url: '/api/v1/sp-api-configs',
        headers,
        payload: { configs },
      });
    const list = (auth = headers) =>
      f.http.inject({
        method: 'GET',
        url: '/api/v1/sp-api-configs',
        headers: auth,
      });

    it('updates a migrated lowercase key without changing identity, keeps timestamps in Shanghai mapping, and audits no raw values', async () => {
      const original = (
        await f.pools.primaryPool.query(
          "INSERT INTO sp_api_config(config_key,config_value,create_time,update_time) VALUES($1,'old-fixture','2026-09-07 08:00:00','2026-09-07 08:00:00') RETURNING id",
          [secretKey.toLowerCase()],
        )
      ).rows[0];
      const result = await write();
      expect(result.statusCode).toBe(200);
      const [saved] = spApiConfigRecordSchema.array().parse(result.json().data);
      expect(saved).toMatchObject({
        id: original.id,
        config_key: secretKey,
        config_value: secret,
        create_time: '2026-09-07T00:00:00.000Z',
      });
      expect(
        Math.abs(Date.parse(saved.update_time!) - Date.now()),
      ).toBeLessThan(10_000);
      expect(
        (
          await f.pools.primaryPool.query(
            'SELECT count(*)::int AS count FROM sp_api_config',
          )
        ).rows[0].count,
      ).toBe(1);
      const detail = await f.http.inject({
        method: 'GET',
        url: `/api/v1/sp-api-configs/${secretKey.toLowerCase()}`,
        headers,
      });
      expect(detail.statusCode).toBe(200);
      expect(detail.json().data.id).toBe(original.id);
      await f.audit.flush();
      const audits = (
        await f.pools.primaryPool.query(
          "SELECT request_data,response_status FROM audit_logs WHERE user_id=$1 AND method='PUT' AND path='/api/v1/sp-api-configs'",
          [operatorId],
        )
      ).rows;
      expect(audits).toHaveLength(1);
      expect(audits[0].response_status).toBe(200);
      expect(audits[0].request_data.configs[0].configValue).not.toBe(secret);
      expect(JSON.stringify(audits)).not.toContain(secret);
      expect(JSON.stringify(f.logger.error.mock.calls)).not.toContain(secret);
    });
    it('rolls back the whole bulk write on a later SQL failure and sanitizes failed-operation audit and logs', async () => {
      await write();
      const result = await write([
        { configKey: secretKey, configValue: 'would-change-fixture-71' },
        {
          configKey: 'SP_API_REFRESH_TOKEN',
          configValue: 'reject-private-fixture-71',
        },
      ]);
      expect(result.statusCode).toBe(500);
      const rows = await repository.readConfiguration();
      expect(rows.map((row) => [row.configKey, row.configValue])).toEqual([
        [secretKey, secret],
      ]);
      await f.audit.flush();
      const audit = (
        await f.pools.primaryPool.query(
          'SELECT request_data,error_message FROM audit_logs WHERE user_id=$1 AND response_status=500',
          [operatorId],
        )
      ).rows;
      expect(audit).toHaveLength(1);
      const exposed = JSON.stringify([
        audit,
        f.logger.error.mock.calls,
        result.body,
      ]);
      expect(exposed).not.toContain('would-change-fixture-71');
      expect(exposed).not.toContain('reject-private-fixture-71');
    });
    it('protects stored and environment credentials for readers, while preserving display defaults and explicit database empty text', async () => {
      await write([
        { configKey: secretKey, configValue: secret },
        { configKey: 'MONITOR_US_SCHEDULE_MINUTES', configValue: '' },
      ]);
      const reader = await user('reader-71');
      const result = await list(reader.headers);
      expect(result.statusCode).toBe(200);
      const rows = spApiDisplayConfigSchema.array().parse(result.json().data);
      expect(rows.find((row) => row.configKey === secretKey)).toMatchObject({
        configValue: '',
        hasValue: true,
      });
      expect(
        rows.find((row) => row.configKey === 'MONITOR_US_SCHEDULE_MINUTES')
          ?.configValue,
      ).toBe('');
      expect(
        rows.find((row) => row.configKey === 'MONITOR_EU_SCHEDULE_MINUTES')
          ?.configValue,
      ).toBe('60');
      expect(result.body).not.toContain(secret);
      expect(result.body).not.toContain('fixture-refresh-71');
      expect(
        (
          await f.http.inject({
            method: 'GET',
            url: `/api/v1/sp-api-configs/${secretKey}`,
            headers: reader.headers,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (
          await f.http.inject({
            method: 'PUT',
            url: '/api/v1/sp-api-configs',
            headers: reader.headers,
            payload: {
              configs: [
                { configKey: secretKey, configValue: 'forbidden-fixture' },
              ],
            },
          })
        ).statusCode,
      ).toBe(403);
    });
    it('serializes with RBAC changes and refuses raw reads/writes after a committed revocation despite primed Redis grants', async () => {
      await write();
      expect((await list()).body).toContain(secret);
      const connection = await f.pools.primaryPool.connect();
      try {
        await connection.query('BEGIN');
        await connection.query(
          'SELECT pg_advisory_xact_lock(1095977294,1380073795)',
        );
        await connection.query(
          "UPDATE user_roles SET role_id='reader-71' WHERE user_id=$1",
          [operatorId],
        );
        let completed = false;
        const pending = list().then((response) => {
          completed = true;
          return response;
        });
        // Observe the actual blocked transaction, not a timing-based sleep.
        await vi.waitFor(
          async () => {
            const waiting = await connection.query(
              "SELECT count(*)::int AS count FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock(1095977294, 1380073795)%'",
            );
            expect(waiting.rows[0].count).toBeGreaterThan(0);
          },
          { timeout: 1000, interval: 20 },
        );
        expect(completed).toBe(false);
        await connection.query('COMMIT');
        const response = await pending;
        expect(response.statusCode).toBe(200);
        expect(response.body).not.toContain(secret);
        expect((await write()).statusCode).toBe(403);
      } finally {
        await connection.query('ROLLBACK');
        connection.release();
      }
    });
    it('uses committed database rotation in the actual shared client and refuses cached credentials during a bounded database failure', async () => {
      await write();
      const source = f.app.get<ApplicationSpApiConfigSource>(
        ApplicationSpApiConfigSource,
      );
      const request = vi.fn(async (input: HttpInput) => ({
        statusCode: 200,
        headers: {},
        body: JSON.stringify(
          input.url.hostname === 'api.amazon.com'
            ? {
                access_token: 'fixture-token-71',
                expires_in: 3600,
                token_type: 'bearer',
              }
            : { asin: 'B000000001' },
        ),
      }));
      const quota: QuotaExecutor = {
        execute: async (_context, task) => task(),
        observe: () => {},
      };
      const client = new SpApiClient({
        config: source,
        transport: { request },
        quota,
        logger: {
          debug: vi.fn(),
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
        },
      });
      const path = '/catalog/2022-04-01/items/B000000001';
      try {
        await client.call('GET', path, 'US');
        await write([
          { configKey: secretKey, configValue: 'rotated-fixture-71' },
        ]);
        await client.call('GET', path, 'US');
        const secrets = request.mock.calls
          .map(([input]) => input)
          .filter((input) => input.url.hostname === 'api.amazon.com')
          .map((input) => new URLSearchParams(input.body).get('client_secret'));
        expect(secrets).toEqual([secret, 'rotated-fixture-71']);
        const calls = request.mock.calls.length;
        const connection = await f.pools.primaryPool.connect();
        try {
          await connection.query('BEGIN');
          await connection.query(
            'LOCK TABLE sp_api_config IN ACCESS EXCLUSIVE MODE',
          );
          await expect(client.call('GET', path, 'US')).rejects.toMatchObject({
            code: 'DEPENDENCY_ERROR',
          });
          expect(request).toHaveBeenCalledTimes(calls);
        } finally {
          await connection.query('ROLLBACK');
          connection.release();
        }
        await client.call('GET', path, 'US');
        expect(request).toHaveBeenCalledTimes(calls + 1);
      } finally {
        client.close();
      }
    });
    it('rejects oversized out-of-band values and excessive rows instead of returning truncated or unbounded configuration', async () => {
      await f.pools.primaryPool.query(
        'INSERT INTO sp_api_config(config_key,config_value) VALUES($1,$2)',
        [secretKey, 'x'.repeat(4097)],
      );
      await expect(repository.readConfiguration()).rejects.toMatchObject({
        reason: 'invalid-result',
      });
      expect((await list()).statusCode).toBe(500);
      await f.pools.primaryPool.query('DELETE FROM sp_api_config');
      await f.pools.primaryPool.query(
        "INSERT INTO sp_api_config(config_key,config_value) SELECT 'fixture_' || n,'' FROM generate_series(1,201) n",
      );
      await expect(repository.readConfiguration()).rejects.toMatchObject({
        reason: 'invalid-result',
      });
    });
    it('rejects pre-cancelled reads before acquiring a database connection', async () => {
      const connect = vi.spyOn(f.pools.primaryPool, 'connect');
      try {
        const abort = new AbortController();
        abort.abort();
        await expect(
          repository.readConfiguration(abort.signal),
        ).rejects.toMatchObject({ reason: 'cancelled' });
        expect(connect).not.toHaveBeenCalled();
      } finally {
        connect.mockRestore();
      }
    });
  },
);
