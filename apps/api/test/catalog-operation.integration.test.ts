import { PgCatalogOperationRepository } from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { authorizeAdministration } from '../src/auth/administration-authorization';
import type { AuthPrincipal } from '../src/auth/auth.types';
import { competitorWriteApp } from './helpers/competitor-write-app';
import { taskAuthFixture } from './helpers/task-query-fixtures';

describe.skipIf(process.env.RUN_INTEGRATION_TESTS !== 'true')(
  'catalog fencing / actual PostgreSQL and HTTP without browser gate headers',
  () => {
    let fixture: Awaited<ReturnType<typeof competitorWriteApp>> | undefined;
    afterEach(async () => {
      await fixture?.close();
      fixture = undefined;
    });
    it.each(['asin', 'competitor'] as const)(
      '%s retains the durable gate across CRUD, deletion and upload; GET remains available',
      async (domain) => {
        const f = await competitorWriteApp({ primaryBusiness: true });
        fixture = f;
        const userId = randomUUID(),
          sessionId = randomUUID();
        f.userIds.add(userId);
        await f.pools.primaryPool.query(
          'INSERT INTO users(id,username,password,force_password_change) VALUES($1,$1,$2,false)',
          [userId, 'fixture-unused-hash'],
        );
        await f.pools.primaryPool.query(
          "INSERT INTO user_roles(user_id,role_id) VALUES($1,'writer-71')",
          [userId],
        );
        await f.pools.primaryPool.query(
          "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,'2099-01-01 08:00:00')",
          [sessionId, userId],
        );
        const headers = {
          authorization: `Bearer ${jwt.sign(
            { userId, sessionId },
            f.env.JWT_SECRET,
            { expiresIn: '1h' },
          )}`,
          origin: f.env.CORS_ORIGIN,
        };
        const prefix = `/api/v1${domain === 'competitor' ? '/competitor' : ''}`;
        const payload =
          domain === 'competitor'
            ? { name: 'Protected group', country: 'US', brand: 'Fixture' }
            : {
                name: 'Protected group',
                country: 'US',
                site: 'amazon.com',
                brand: 'Fixture',
              };
        const created = await f.http.inject({
          method: 'POST',
          url: `${prefix}/variant-groups`,
          headers,
          payload,
        });
        expect(created.statusCode).toBe(200);
        const groupId = created.json().data.id as string;
        const repository = new PgCatalogOperationRepository(
          f.pools.primaryPool,
        );
        expect(await repository.read(userId, domain)).toBeNull();
        const principal: AuthPrincipal = {
          userId,
          sessionId,
          user: {
            ...taskAuthFixture().user,
            id: userId,
            status: 'ACTIVE',
            forcePasswordChange: false,
          },
        };
        const operation = await repository.reserve(
          { ownerId: userId, domain, kind: 'import' },
          (unit) => authorizeAdministration(unit, principal, 'asin:write'),
        );
        const binding = {
          taskId: randomUUID(),
          userId,
          taskType: 'import' as const,
          taskSubType: domain === 'asin' ? 'asin' : 'competitor-asin',
          createdAt: new Date().toISOString(),
        };
        await repository.bindTask(operation, binding);
        const before = await repository.read(userId, domain);
        expect(before).toMatchObject({
          ...operation,
          task: binding,
          state: 'open',
        });
        const changed = await f.http.inject({
          method: 'PUT',
          url: `${prefix}/variant-groups/${encodeURIComponent(groupId)}`,
          headers,
          payload: { ...payload, name: 'Unexpected edit' },
        });
        const deletion = await f.http.inject({
          method: 'POST',
          url: `${prefix}/variant-groups/batch-delete`,
          headers,
          payload: { groupIds: [groupId], useAsync: false },
        });
        const boundary = `fixture-${randomUUID()}`;
        const upload = await f.http.inject({
          method: 'POST',
          url: `${prefix}/variant-groups/import-excel`,
          headers: {
            ...headers,
            'content-type': `multipart/form-data; boundary=${boundary}`,
          },
          payload: Buffer.from(
            `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.csv"\r\nContent-Type: text/csv\r\n\r\nASIN,country\nB000000224,US\r\n--${boundary}--\r\n`,
          ),
        });
        for (const response of [changed, deletion, upload]) {
          expect(response.statusCode).toBe(409);
          expect(response.json()).toMatchObject({
            success: false,
            errorCode: 409,
          });
          expect(response.body).not.toContain(operation.operationId);
          expect(response.body).not.toContain('catalog_operation_slots');
        }
        const read = await f.http.inject({
          method: 'GET',
          url: `${prefix}/variant-groups/${encodeURIComponent(groupId)}`,
          headers,
        });
        expect(read.statusCode).toBe(200);
        expect(read.json().data.name).toBe(payload.name);
        expect(await repository.read(userId, domain)).toEqual(before);
        await f.pools.primaryPool.query(
          "DELETE FROM role_permissions WHERE role_id='writer-71' AND permission_id IN (SELECT id FROM permissions WHERE code='asin:write')",
        );
        const revoked = await f.http.inject({
          method: 'PUT',
          url: `${prefix}/variant-groups/${encodeURIComponent(groupId)}`,
          headers,
          payload,
        });
        expect(revoked.statusCode).toBe(403);
        expect(await repository.read(userId, domain)).toEqual(before);
        await f.pools.primaryPool.query(
          "INSERT INTO role_permissions(role_id,permission_id) SELECT 'writer-71',id FROM permissions WHERE code='asin:write'",
        );
        // No Redis task or queue job was published by this fixture. Its known
        // non-enqueue proof can release only this exact operation generation.
        await repository.close(operation, {
          status: 'rejected',
          source: 'producer',
          task: binding,
        });
        expect(await repository.release(operation)).toBe(true);
        const next = await f.http.inject({
          method: 'PUT',
          url: `${prefix}/variant-groups/${encodeURIComponent(groupId)}`,
          headers,
          payload: { ...payload, name: 'Verified edit' },
        });
        expect(next.statusCode).toBe(200);
        expect(next.json().data.name).toBe('Verified edit');
        expect(await repository.read(userId, domain)).toBeNull();
      },
    );
  },
);
