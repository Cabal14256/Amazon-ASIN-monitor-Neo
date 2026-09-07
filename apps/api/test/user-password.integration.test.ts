import { messageResultSchema } from '@asin-monitor/contracts';
import {
  PgUserPasswordRepository,
  type UserPasswordRepositoryPort,
} from '@asin-monitor/db';
import bcrypt from 'bcryptjs';
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
import { USER_PASSWORD_REPOSITORY } from '../src/users/user-password.service';
import { userAdministrationApp } from './helpers/user-administration-app';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'Neo administrator password reset / real PostgreSQL and Redis',
  () => {
    let f: Awaited<ReturnType<typeof userAdministrationApp>>;
    let repository: UserPasswordRepositoryPort;
    let operatorId: string;
    let headers: { authorization: string };
    let originalHash: string;
    const original = 'Integration-Original-63';
    const replacement = 'Integration-Replacement-63';
    beforeAll(async () => {
      f = await userAdministrationApp();
      repository = f.app.get(USER_PASSWORD_REPOSITORY);
      expect(repository).toBeInstanceOf(PgUserPasswordRepository);
      originalHash = await bcrypt.hash(original, 10);
    });
    afterAll(async () => {
      try {
        if (f) await f.close();
      } finally {
        vi.restoreAllMocks();
      }
    });
    async function seedUser(admin = false, username = `u63-${randomUUID()}`) {
      const id = randomUUID();
      f.userIds.add(id);
      await f.pools.primaryPool.query(
        'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$2,$3,false)',
        [id, username, originalHash],
      );
      await f.pools.primaryPool.query(
        'INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)',
        [id, admin ? 'role-admin-61' : 'role-reader-61'],
      );
      return id;
    }
    async function session(userId: string) {
      const sessionId = randomUUID();
      await f.pools.primaryPool.query(
        "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,'2099-01-01 08:00:00')",
        [sessionId, userId],
      );
      return {
        sessionId,
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
      operatorId = await seedUser(true);
      headers = (await session(operatorId)).headers;
    });
    const reset = (
      id: string,
      payload: object = { newPassword: replacement },
    ) =>
      f.http.inject({
        method: 'PUT',
        url: `/api/v1/users/${id}/password`,
        headers,
        payload,
      });
    const stored = async (id: string) =>
      (await f.pools.primaryPool.query('SELECT * FROM users WHERE id=$1', [id]))
        .rows[0];
    const history = async (id: string) =>
      (
        await f.pools.primaryPool.query(
          'SELECT * FROM password_history WHERE user_id=$1 ORDER BY created_at DESC NULLS LAST,id DESC',
          [id],
        )
      ).rows;
    const sessionRows = async (id: string) =>
      (
        await f.pools.primaryPool.query(
          'SELECT * FROM sessions WHERE user_id=$1 ORDER BY id',
          [id],
        )
      ).rows;

    it('persists bcrypt, history/default policy, revokes old JWT sessions and emits a sanitized reset audit', async () => {
      const target = await seedUser();
      const oldSession = await session(target);
      await session(target);
      const response = await reset(target);
      expect(response.statusCode).toBe(200);
      expect(messageResultSchema.parse(response.json()).message).toBe(
        '密码修改成功，用户会话已全部下线，下次登录需修改密码',
      );
      const row = await stored(target);
      expect(await bcrypt.compare(replacement, row.password)).toBe(true);
      expect(bcrypt.getRounds(row.password)).toBe(10);
      expect(row.force_password_change).toBe(true);
      expect(
        row.password_expires_at.getTime() - row.password_changed_at.getTime(),
      ).toBe(90 * 86_400_000);
      expect(
        (await history(target)).map((entry) => entry.password_hash),
      ).toEqual([originalHash]);
      expect((await sessionRows(target)).map((entry) => entry.status)).toEqual([
        'REVOKED',
        'REVOKED',
      ]);
      expect(
        (
          await f.http.inject({
            method: 'GET',
            url: '/api/v1/auth/current-user',
            headers: oldSession.headers,
          })
        ).statusCode,
      ).toBe(403);
      const login = await f.http.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { username: row.username, password: replacement },
      });
      expect(login.statusCode).toBe(200);
      expect(login.json().data.mustChangePassword).toBe(true);
      await f.audit.flush();
      const entries = (
        await f.pools.primaryPool.query(
          "SELECT * FROM audit_logs WHERE user_id=$1 AND resource_id=$2 AND action='RESET_PASSWORD' AND resource='user'",
          [operatorId, target],
        )
      ).rows;
      expect(entries.some((entry) => entry.response_status === 200)).toBe(true);
      for (const secret of [
        original,
        replacement,
        originalHash,
        row.password,
      ]) {
        expect(JSON.stringify(entries)).not.toContain(secret);
        expect(response.body).not.toContain(secret);
        expect(JSON.stringify(f.logger.error.mock.calls)).not.toContain(secret);
      }
    });
    it.each([
      [false, false],
      [true, false],
      [false, true],
    ])(
      'preserves independent forceChange=%s / revokeAll=%s choices and unrelated account state',
      async (forceChangeOnNextLogin, revokeAllSessions) => {
        const target = await seedUser();
        const existing = await session(target);
        await f.pools.primaryPool.query(
          "UPDATE users SET failed_login_attempts=2,last_failed_login='2026-09-01 08:00:00',locked_until=NULL WHERE id=$1",
          [target],
        );
        const before = await stored(target);
        const response = await reset(target, {
          newPassword: replacement,
          forceChangeOnNextLogin,
          revokeAllSessions,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().message).toBe('密码修改成功');
        const after = await stored(target);
        expect(after.force_password_change).toBe(forceChangeOnNextLogin);
        expect(after.failed_login_attempts).toBe(2);
        expect(after.last_failed_login).toEqual(before.last_failed_login);
        expect(after.status).toBe(before.status);
        expect((await sessionRows(target))[0].status).toBe(
          revokeAllSessions ? 'REVOKED' : 'ACTIVE',
        );
        const current = await f.http.inject({
          method: 'GET',
          url: '/api/v1/auth/current-user',
          headers: existing.headers,
        });
        expect(current.statusCode).toBe(revokeAllSessions ? 403 : 200);
        if (!revokeAllSessions)
          expect(current.json().data.mustChangePassword).toBe(
            forceChangeOnNextLogin,
          );
      },
    );
    it('rejects current, recent and username passwords and trims actual history to the latest five', async () => {
      const target = await seedUser(false, replacement.toUpperCase());
      const recent = Array.from(
        { length: 6 },
        (_, i) => `Integration-History-${i}-63`,
      );
      const hashes = await Promise.all(
        recent.map((password) => bcrypt.hash(password, 4)),
      );
      for (let i = 0; i < hashes.length; i++)
        await f.pools.primaryPool.query(
          'INSERT INTO password_history(user_id,password_hash,created_at) VALUES($1,$2,$3)',
          [target, hashes[i], `2025-01-0${i + 1} 08:00:00`],
        );
      const before = await stored(target);
      for (const newPassword of [replacement, original, recent[5]])
        expect((await reset(target, { newPassword })).statusCode).toBe(400);
      expect(await stored(target)).toEqual(before);
      expect(await history(target)).toHaveLength(6);
      // The sixth-oldest historical value is outside the retained policy window.
      expect((await reset(target, { newPassword: recent[0] })).statusCode).toBe(
        200,
      );
      expect(
        (await history(target)).map((entry) => entry.password_hash),
      ).toEqual([originalHash, hashes[5], hashes[4], hashes[3], hashes[2]]);
    });
    it('rolls back history trimming, password policy and all sessions when revocation SQL fails', async () => {
      const target = await seedUser();
      await session(target);
      await session(target);
      for (let i = 0; i < 5; i++)
        await f.pools.primaryPool.query(
          'INSERT INTO password_history(user_id,password_hash,created_at) VALUES($1,$2,$3)',
          [target, originalHash, `2025-01-0${i + 1} 08:00:00`],
        );
      const before = {
        user: await stored(target),
        history: await history(target),
        sessions: await sessionRows(target),
      };
      // The helper verified this connection's random private search_path. The
      // trigger targets only this generated fixture UUID and is removed in finally.
      await f.pools.primaryPool.query(
        `CREATE FUNCTION reject_reset_63() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.user_id='${target}' AND NEW.status='REVOKED' THEN RAISE EXCEPTION 'fixture-private-password-reset-failure'; END IF; RETURN NEW; END $$`,
      );
      await f.pools.primaryPool.query(
        'CREATE TRIGGER reject_reset_63 AFTER UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION reject_reset_63()',
      );
      try {
        const response = await reset(target);
        expect(response.statusCode).toBe(500);
        expect(response.body).not.toContain(
          'fixture-private-password-reset-failure',
        );
      } finally {
        await f.pools.primaryPool.query(
          'DROP TRIGGER reject_reset_63 ON sessions',
        );
        await f.pools.primaryPool.query('DROP FUNCTION reject_reset_63()');
      }
      expect({
        user: await stored(target),
        history: await history(target),
        sessions: await sessionRows(target),
      }).toEqual(before);
      expect(JSON.stringify(f.logger.error.mock.calls)).not.toContain(
        'fixture-private-password-reset-failure',
      );
      expect((await reset(target)).statusCode).toBe(200);
    });
    it('serializes administrator reset with the actual own-password endpoint without duplicate history', async () => {
      const target = await seedUser();
      const own = await session(target);
      const results = await Promise.all([
        reset(target, {
          newPassword: replacement,
          forceChangeOnNextLogin: false,
          revokeAllSessions: false,
        }),
        f.http.inject({
          method: 'POST',
          url: '/api/v1/auth/change-password',
          headers: own.headers,
          payload: {
            oldPassword: original,
            newPassword: replacement,
            revokeOtherSessions: false,
          },
        }),
      ]);
      expect(results.map((response) => response.statusCode).sort()).toEqual([
        200, 400,
      ]);
      expect(
        await bcrypt.compare(replacement, (await stored(target)).password),
      ).toBe(true);
      expect(
        (await history(target)).map((entry) => entry.password_hash),
      ).toEqual([originalHash]);
      expect((await sessionRows(target))[0].status).toBe('ACTIVE');
    });
    it('rechecks operator permission after waiting for the shared RBAC lock', async () => {
      const target = await seedUser();
      const connection = await f.pools.primaryPool.connect();
      await connection.query('BEGIN');
      await connection.query(
        'SELECT pg_advisory_xact_lock(1095977294,1380073795)',
      );
      const spy = vi.spyOn(repository, 'transaction');
      const pending = reset(target);
      try {
        await vi.waitFor(() => expect(spy).toHaveBeenCalled(), {
          timeout: 1000,
        });
        await connection.query('DELETE FROM user_roles WHERE user_id=$1', [
          operatorId,
        ]);
        await connection.query('COMMIT');
      } finally {
        await connection.query('ROLLBACK');
        connection.release();
        spy.mockRestore();
      }
      expect((await pending).statusCode).toBe(403);
      expect((await stored(target)).password).toBe(originalHash);
      expect(await history(target)).toEqual([]);
    });
    it('aborts a target-user lock timeout with no late password/history/session writes', async () => {
      const target = await seedUser();
      await session(target);
      const before = {
        user: await stored(target),
        history: await history(target),
        sessions: await sessionRows(target),
      };
      const connection = await f.pools.primaryPool.connect();
      await connection.query('BEGIN');
      await connection.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [
        target,
      ]);
      try {
        expect((await reset(target)).statusCode).toBe(500);
      } finally {
        await connection.query('ROLLBACK');
        connection.release();
      }
      expect({
        user: await stored(target),
        history: await history(target),
        sessions: await sessionRows(target),
      }).toEqual(before);
      expect((await reset(target)).statusCode).toBe(200);
    });
  },
);
