import { sessionListResultSchema } from '@asin-monitor/contracts';
import {
  BoundedAuthRepository,
  LegacyMysqlAuthRepository,
} from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AUTH_DATA_REPOSITORY } from '../src/auth/auth.constants';
import { AuthenticationService } from '../src/auth/authentication.service';
import { ApplicationDatabasePools } from '../src/database/database.service';
import { sessionApp } from './helpers/session-app';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'Neo session management authority integration',
  () => {
    it.each(['postgresql', 'legacy-mysql'] as const)(
      'queries and revokes only owned sessions in %s',
      async (authority) => {
        const userId = `s51-${randomUUID()}`;
        const foreignUserId = `s51-${randomUUID()}`;
        const currentId = randomUUID();
        const otherId = randomUUID();
        const foreignId = randomUUID();
        const historicalId = `legacy-${randomUUID().slice(0, 29)}`;
        const expiredId = randomUUID();
        const fixture = await sessionApp(undefined, {
          ...process.env,
          AUTH_DATA_AUTHORITY: authority,
        });
        const pg = fixture.app.get(ApplicationDatabasePools).primaryPool;
        const legacy =
          authority === 'legacy-mysql'
            ? mysql.createPool({
                host: process.env.DB_HOST!,
                port: Number(process.env.DB_PORT ?? 3306),
                user: process.env.DB_USER!,
                password: process.env.DB_PASSWORD!,
                database: process.env.DB_NAME!,
                dateStrings: true,
              })
            : undefined;
        const execute = async (
          sql: string,
          values: unknown[] = [],
        ): Promise<Record<string, unknown>[]> => {
          if (!legacy) return (await pg.query(sql, values)).rows;
          const [rows] = await legacy.query<RowDataPacket[]>(
            sql.replace(/\$\d+/g, '?'),
            values,
          );
          return Array.isArray(rows) ? rows : [];
        };
        try {
          if (legacy) {
            await legacy.query(`CREATE TABLE IF NOT EXISTS users (
          id VARCHAR(50) PRIMARY KEY, username VARCHAR(50) NOT NULL,
          password VARCHAR(255) NOT NULL, real_name VARCHAR(100) NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE', last_login_time DATETIME NULL,
          last_login_ip VARCHAR(50) NULL, password_expires_at DATETIME NULL,
          password_changed_at DATETIME NULL, force_password_change TINYINT(1) NULL DEFAULT 0,
          failed_login_attempts INT NULL DEFAULT 0, locked_until DATETIME NULL,
          create_time DATETIME NULL, update_time DATETIME NULL)`);
            await legacy.query(`CREATE TABLE IF NOT EXISTS sessions (
          id CHAR(36) PRIMARY KEY, user_id VARCHAR(50) NOT NULL,
          user_agent VARCHAR(255) NULL, ip_address VARCHAR(64) NULL,
          status VARCHAR(7) NOT NULL DEFAULT 'ACTIVE', remember_me TINYINT(1) NOT NULL DEFAULT 0,
          created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_active_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at DATETIME NULL)`);
          }
          expect(fixture.app.get(AUTH_DATA_REPOSITORY)).toBeInstanceOf(
            legacy ? LegacyMysqlAuthRepository : BoundedAuthRepository,
          );
          for (const owner of [userId, foreignUserId]) {
            await execute(
              'INSERT INTO users (id, username, password, status) VALUES ($1,$2,$3,$4)',
              [owner, owner, 'fixture-unused-hash', 'ACTIVE'],
            );
          }
          for (const [id, owner, status, expiry] of [
            [currentId, userId, 'ACTIVE', '2099-01-01 08:00:00'],
            [otherId, userId, 'ACTIVE', '2099-01-01 08:00:00'],
            [foreignId, foreignUserId, 'ACTIVE', '2099-01-01 08:00:00'],
            [historicalId, userId, 'REVOKED', null],
            [expiredId, userId, 'ACTIVE', '2000-01-01 08:00:00'],
          ]) {
            await execute(
              'INSERT INTO sessions (id,user_id,status,expires_at,created_at,last_active_at) VALUES ($1,$2,$3,$4,$5,$6)',
              [
                id,
                owner,
                status,
                expiry,
                '2026-09-01 08:00:00',
                '2026-09-01 08:00:00',
              ],
            );
          }
          const token = jwt.sign(
            { userId, sessionId: currentId },
            fixture.env.JWT_SECRET,
            { expiresIn: '1h' },
          );
          const headers = { authorization: `Bearer ${token}` };
          const list = await fixture.http.inject({
            method: 'GET',
            url: '/api/v1/auth/sessions',
            headers,
          });
          expect(list.statusCode).toBe(200);
          const rows = sessionListResultSchema.parse(list.json()).data!;
          expect(rows).toHaveLength(4);
          expect(rows.every((row) => row.user_id === userId)).toBe(true);
          expect(rows.find((row) => row.id === otherId)).toMatchObject({
            created_at: '2026-09-01T00:00:00.000Z',
            expires_at: '2099-01-01T00:00:00.000Z',
          });
          expect(rows.find((row) => row.id === historicalId)).toMatchObject({
            status: 'REVOKED',
            expires_at: null,
          });
          expect(rows.find((row) => row.id === expiredId)).toMatchObject({
            status: 'ACTIVE',
          });
          for (const id of [foreignId, randomUUID()]) {
            const response = await fixture.http.inject({
              method: 'POST',
              url: '/api/v1/auth/sessions/revoke',
              headers,
              payload: { sessionId: id },
            });
            expect(response.statusCode).toBe(404);
          }
          expect(
            (
              await execute('SELECT status FROM sessions WHERE id = $1', [
                foreignId,
              ])
            )[0].status,
          ).toBe('ACTIVE');
          for (const id of [otherId, otherId, historicalId]) {
            const response = await fixture.http.inject({
              method: 'POST',
              url: '/api/v1/auth/sessions/revoke',
              headers,
              payload: { sessionId: id },
            });
            expect(response.statusCode).toBe(200);
            expect(
              (
                await execute('SELECT status FROM sessions WHERE id = $1', [id])
              )[0].status,
            ).toBe('REVOKED');
          }
          const revokedToken = jwt.sign(
            { userId, sessionId: otherId },
            fixture.env.JWT_SECRET,
            { expiresIn: '1h' },
          );
          await expect(
            fixture.app
              .get(AuthenticationService)
              .authenticateToken(revokedToken),
          ).rejects.toMatchObject({ status: 403 });
          const logout = await fixture.http.inject({
            method: 'POST',
            url: '/api/v1/auth/logout',
            headers,
          });
          expect(logout.statusCode).toBe(200);
          expect(logout.headers['set-cookie']).toHaveLength(2);
          expect(
            (
              await execute('SELECT status FROM sessions WHERE id = $1', [
                currentId,
              ])
            )[0].status,
          ).toBe('REVOKED');
          const after = await fixture.http.inject({
            method: 'GET',
            url: '/api/v1/auth/sessions',
            headers,
          });
          expect(after.statusCode).toBe(403);
        } finally {
          try {
            await execute('DELETE FROM sessions WHERE user_id IN ($1,$2)', [
              userId,
              foreignUserId,
            ]);
            await execute('DELETE FROM users WHERE id IN ($1,$2)', [
              userId,
              foreignUserId,
            ]);
          } finally {
            await fixture.app.close();
            if (legacy) await legacy.end();
          }
        }
      },
      20000,
    );
  },
);
