import {
  userDetailResultSchema,
  userListResultSchema,
} from '@asin-monitor/contracts';
import { PgUserQueryRepository } from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApplicationDatabasePools } from '../src/database/database.service';
import { RoleModule } from '../src/roles/role.module';
import { UserQueryModule } from '../src/users/user-query.module';
import { sessionApp } from './helpers/session-app';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'Neo user queries / real PostgreSQL',
  () => {
    let fixture: Awaited<ReturnType<typeof sessionApp>>;
    let pools: ApplicationDatabasePools;
    const userIds: string[] = [];
    const roleIds: string[] = [];
    beforeAll(async () => {
      fixture = await sessionApp(
        undefined,
        {
          DATABASE_URL: process.env.DATABASE_URL,
          COMPETITOR_DATABASE_URL: process.env.COMPETITOR_DATABASE_URL,
        },
        undefined,
        [UserQueryModule, RoleModule],
      );
      pools = fixture.app.get(ApplicationDatabasePools);
    });
    afterAll(async () => {
      try {
        if (pools && userIds.length)
          await pools.primaryPool.query(
            'DELETE FROM users WHERE id=ANY($1::text[])',
            [userIds],
          );
        if (pools && roleIds.length)
          await pools.primaryPool.query(
            'DELETE FROM roles WHERE id=ANY($1::text[])',
            [roleIds],
          );
      } finally {
        if (fixture) await fixture.app.close();
      }
    });
    async function data() {
      const marker = `q59-${randomUUID()}`;
      const operatorId = `o59-${randomUUID()}`;
      const operatorRole = `r59-${randomUUID()}`;
      const targetRole = `r59-${randomUUID()}`;
      const ids = Array.from({ length: 4 }, () => `u59-${randomUUID()}`);
      const sessionId = randomUUID();
      userIds.push(operatorId, ...ids);
      roleIds.push(operatorRole, targetRole);
      await pools.primaryPool.query(
        "INSERT INTO users(id,username,password,force_password_change) VALUES($1,$1,'fixture-private-hash',false)",
        [operatorId],
      );
      await pools.primaryPool.query(
        "INSERT INTO roles(id,code,name) VALUES($1,$1,'Query operator'),($2,$2,'Query target')",
        [operatorRole, targetRole],
      );
      await pools.primaryPool.query(
        'INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code=$2',
        [operatorRole, 'user:read'],
      );
      await pools.primaryPool.query(
        'INSERT INTO role_permissions(role_id,permission_id) SELECT $1,id FROM permissions WHERE code=$2',
        [targetRole, 'asin:read'],
      );
      await pools.primaryPool.query(
        'INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)',
        [operatorId, operatorRole],
      );
      await pools.primaryPool.query(
        "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,'2099-01-01 08:00:00')",
        [sessionId, operatorId],
      );
      for (let index = 0; index < ids.length; index++) {
        await pools.primaryPool.query(
          "INSERT INTO users(id,username,password,status,create_time,update_time,force_password_change) VALUES($1,$2,'fixture-private-hash',$3,$4,NULL,false)",
          [
            ids[index],
            `${marker}-${index}`,
            index === 3 ? 'INACTIVE' : 'ACTIVE',
            index === 3 ? null : `2026-09-0${index + 1} 08:00:00`,
          ],
        );
      }
      await pools.primaryPool.query(
        'INSERT INTO user_roles(user_id,role_id) VALUES($1,$3),($2,$3)',
        [ids[0], ids[1], targetRole],
      );
      const headers = {
        authorization: `Bearer ${jwt.sign(
          { userId: operatorId, sessionId },
          fixture.env.JWT_SECRET,
          { expiresIn: '1h' },
        )}`,
      };
      const get = (path: string) =>
        fixture.http.inject({ method: 'GET', url: `/api/v1${path}`, headers });
      return { marker, operatorId, operatorRole, targetRole, ids, get };
    }
    function observedRepository(
      afterQuery: (text: string) => Promise<void> = async () => {},
    ) {
      const statements: string[] = [];
      const pool = new Proxy(pools.primaryPool, {
        get(target, key) {
          if (key === 'connect')
            return async () => {
              const client = await target.connect();
              const query = client.query.bind(client) as (
                ...args: unknown[]
              ) => Promise<unknown>;
              return new Proxy(client, {
                get(connection, name) {
                  if (name === 'query')
                    return async (...args: unknown[]) => {
                      const input = args[0];
                      const text =
                        typeof input === 'string'
                          ? input
                          : String((input as { text: string }).text);
                      statements.push(text);
                      const result = await query(...args);
                      await afterQuery(text);
                      return result;
                    };
                  const value = Reflect.get(connection, name);
                  return typeof value === 'function'
                    ? value.bind(connection)
                    : value;
                },
              });
            };
          const value = Reflect.get(target, key);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return { repository: new PgUserQueryRepository(pool), statements };
    }

    it('filters and paginates actual users with deterministic NULL ordering and bounded role queries', async () => {
      const f = await data();
      const result = await f.get(
        `/users?username=${f.marker.toUpperCase()}&current=1&pageSize=2`,
      );
      expect(result.statusCode).toBe(200);
      const page = userListResultSchema.parse(result.json()).data!;
      expect(page.total).toBe(4);
      expect(page.list.map((row) => row.id)).toEqual([f.ids[2], f.ids[1]]);
      expect(page.list[0].roles).toEqual([]);
      expect(page.list[1].roles?.[0].id).toBe(f.targetRole);
      expect(page.list[1].create_time).toBe('2026-09-02T00:00:00.000Z');
      const next = userListResultSchema.parse(
        (
          await f.get(`/users?username=${f.marker}&current=2&pageSize=2`)
        ).json(),
      ).data!;
      expect(next.list.map((row) => row.id)).toEqual([f.ids[0], f.ids[3]]);
      expect(next.list[1].create_time).toBeNull();
      const filtered = userListResultSchema.parse(
        (await f.get(`/users?username=${f.marker}&status=INACTIVE`)).json(),
      ).data!;
      expect(filtered.total).toBe(1);
      expect(filtered.list[0].id).toBe(f.ids[3]);
      expect(
        (
          await f.get(
            `/users?username=${encodeURIComponent(`${f.marker}' OR 1=1 --`)}`,
          )
        ).json().data.total,
      ).toBe(0);
      expect(
        (await f.get(`/users?username=${f.marker}%25`)).json().data.total,
      ).toBe(4);
      const observed = observedRepository();
      await observed.repository.list({
        username: f.marker,
        current: 1,
        pageSize: 100,
      });
      expect(
        observed.statements.filter((text) => /^select /i.test(text)),
      ).toHaveLength(3);
      expect(
        observed.statements.some((text) =>
          /"password"|"last_failed_login"/.test(text),
        ),
      ).toBe(false);
    });
    it('returns public details and the latest ten status changes without credential fields', async () => {
      const f = await data();
      for (let index = 0; index < 12; index++) {
        await pools.primaryPool.query(
          'INSERT INTO user_status_history(id,user_id,old_status,new_status,reason,created_at) OVERRIDING SYSTEM VALUE VALUES($5,$1,NULL,$2,$3,$4)',
          [
            f.ids[0],
            'ACTIVE',
            `change-${index}`,
            `2026-09-01 08:${String(index).padStart(2, '0')}:00`,
            randomInt(1_000_000_000_000, 2_000_000_000_000),
          ],
        );
      }
      await pools.primaryPool.query(
        'INSERT INTO user_status_history(id,user_id,new_status,created_at) OVERRIDING SYSTEM VALUE VALUES($3,$1,$2,NULL)',
        [f.ids[3], 'INACTIVE', randomInt(1_000_000_000_000, 2_000_000_000_000)],
      );
      const response = await f.get(`/users/${f.ids[0]}`);
      expect(response.statusCode).toBe(200);
      const detail = userDetailResultSchema.parse(response.json()).data!;
      expect(detail.roles?.[0].id).toBe(f.targetRole);
      expect(detail.permissions).toEqual(['asin:read']);
      expect(detail.statusHistory?.map((row) => row.reason)).toEqual(
        Array.from({ length: 10 }, (_, index) => `change-${11 - index}`),
      );
      expect(detail.statusHistory?.[0].created_at).toBe(
        '2026-09-01T00:11:00.000Z',
      );
      const nullable = userDetailResultSchema.parse(
        (await f.get(`/users/${f.ids[3]}`)).json(),
      ).data!;
      expect(nullable.statusHistory?.[0].created_at).toBeNull();
      expect(nullable.create_time).toBeNull();
      expect(response.body).not.toContain('fixture-private-hash');
      expect(response.json().data).not.toHaveProperty('password');
      expect((await f.get('/users/nonexistent-user-59')).statusCode).toBe(404);
      expect((await f.get('/users/roles/all')).statusCode).toBe(403); // Existing role dropdown keeps role:read.
    });
    it('rejects an actual imported history ID beyond the safe integer range', async () => {
      const f = await data();
      await pools.primaryPool.query(
        'INSERT INTO user_status_history(id,user_id,new_status) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3)',
        [
          (2n ** 60n + BigInt(randomInt(1_000_000_000))).toString(),
          f.ids[0],
          'ACTIVE',
        ],
      );
      const response = await f.get(`/users/${f.ids[0]}`);
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('Invalid history ID');
    });
    it('holds one list snapshot across a concurrent user insertion and role replacement', async () => {
      const f = await data();
      const insertedId = `u59-${randomUUID()}`;
      userIds.push(insertedId);
      let changed = false;
      const observed = observedRepository(async (text) => {
        if (changed || !text.startsWith('select count(*)')) return;
        changed = true;
        const writer = await pools.primaryPool.connect();
        try {
          await writer.query('BEGIN');
          await writer.query(
            "INSERT INTO users(id,username,password) VALUES($1,$2,'fixture-private-hash')",
            [insertedId, `${f.marker}-new`],
          );
          await writer.query('DELETE FROM user_roles WHERE user_id=$1', [
            f.ids[0],
          ]);
          await writer.query('COMMIT');
        } finally {
          await writer.query('ROLLBACK');
          writer.release();
        }
      });
      const snapshot = await observed.repository.list({
        username: f.marker,
        current: 1,
        pageSize: 100,
      });
      expect(changed).toBe(true);
      expect(snapshot.total).toBe(4);
      expect(snapshot.users).toHaveLength(4);
      expect(snapshot.roles.some((row) => row.userId === f.ids[0])).toBe(true);
      const current = await new PgUserQueryRepository(pools.primaryPool).list({
        username: f.marker,
        current: 1,
        pageSize: 100,
      });
      expect(current.total).toBe(5);
      expect(current.roles.some((row) => row.userId === f.ids[0])).toBe(false);
    });
    it('holds detail, roles, permissions and history in the same snapshot', async () => {
      const f = await data();
      let changed = false;
      const observed = observedRepository(async (text) => {
        if (changed || !text.includes('from "users"')) return;
        changed = true;
        const writer = await pools.primaryPool.connect();
        try {
          await writer.query('BEGIN');
          await writer.query('UPDATE users SET real_name=$1 WHERE id=$2', [
            'after-snapshot',
            f.ids[0],
          ]);
          await writer.query('DELETE FROM user_roles WHERE user_id=$1', [
            f.ids[0],
          ]);
          await writer.query(
            'INSERT INTO user_status_history(user_id,new_status) VALUES($1,$2)',
            [f.ids[0], 'ACTIVE'],
          );
          await writer.query('COMMIT');
        } finally {
          await writer.query('ROLLBACK');
          writer.release();
        }
      });
      const snapshot = await observed.repository.detail(f.ids[0]);
      expect(changed).toBe(true);
      expect(snapshot?.user.realName).toBeNull();
      expect(snapshot?.roles).toHaveLength(1);
      expect(snapshot?.permissions).toEqual(['asin:read']);
      expect(snapshot?.statusHistory).toHaveLength(0);
      expect(
        observed.statements.some((text) =>
          /"password"|"password_hash"/.test(text),
        ),
      ).toBe(false);
      const current = await new PgUserQueryRepository(pools.primaryPool).detail(
        f.ids[0],
      );
      expect(current?.user.realName).toBe('after-snapshot');
      expect(current?.roles).toHaveLength(0);
      expect(current?.permissions).toEqual([]);
      expect(current?.statusHistory).toHaveLength(1);
    });
    it('cancels a blocked PostgreSQL read and recovers after the lock is released', async () => {
      const f = await data();
      const connection = await pools.primaryPool.connect();
      await connection.query('BEGIN');
      await connection.query('LOCK TABLE users IN ACCESS EXCLUSIVE MODE');
      const repository = new PgUserQueryRepository(pools.primaryPool);
      try {
        await expect(
          repository.list({ username: f.marker, current: 1, pageSize: 10 }),
        ).rejects.toThrow();
      } finally {
        await connection.query('ROLLBACK');
        connection.release();
      }
      expect(
        (
          await repository.list({
            username: f.marker,
            current: 1,
            pageSize: 10,
          })
        ).total,
      ).toBe(4);
      expect((await f.get(`/users?username=${f.marker}`)).statusCode).toBe(200);
    });
  },
);
