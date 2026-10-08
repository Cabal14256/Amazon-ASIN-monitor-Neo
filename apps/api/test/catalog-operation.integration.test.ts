import {
  PgCatalogOperationRepository,
  PgCompetitorWriteRepository,
  withCatalogOperationExecution,
  type CompetitorWriteRepositoryPort,
} from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorizeAdministration } from '../src/auth/administration-authorization';
import type { AuthPrincipal } from '../src/auth/auth.types';
import { ApplicationCatalogOperations } from '../src/catalog/catalog-operation.service';
import { COMPETITOR_WRITE_REPOSITORY } from '../src/competitor/competitor-write.service';
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
    it.each([
      {
        description:
          'returns HTTP 409 to a second authorized session while a real 4-second competitor business transaction holds assertPin SHARE, without starting a second action',
        separateSession: true,
        expectedStatus: 409,
      },
      {
        description:
          'preserves authentication HTTP 503 when the same-session heartbeat is blocked before catalog admission, without starting a second action',
        separateSession: false,
        expectedStatus: 503,
      },
    ])('$description', async ({ separateSession, expectedStatus }) => {
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
      // A same-session HTTP heartbeat updates the row held FOR SHARE by the
      // original business authorization. Use another real session of the same
      // owner to reach slot arbitration; separately retain that auth-503 path.
      const requestSessionId = separateSession ? randomUUID() : sessionId;
      if (separateSession)
        await f.pools.primaryPool.query(
          "INSERT INTO sessions(id,user_id,expires_at) VALUES($1,$2,'2099-01-01 08:00:00')",
          [requestSessionId, userId],
        );
      const requestHeaders = {
        ...headers,
        authorization: `Bearer ${jwt.sign(
          { userId, sessionId: requestSessionId },
          f.env.JWT_SECRET,
          { expiresIn: '1h' },
        )}`,
      };
      const payload = {
        name: 'Held competitor group',
        country: 'US',
        brand: 'Fixture',
      };
      const created = await f.http.inject({
        method: 'POST',
        url: '/api/v1/competitor/variant-groups',
        headers,
        payload,
      });
      expect(created.statusCode).toBe(200);
      const groupId = created.json().data.id as string;
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
      const repository = new PgCatalogOperationRepository(f.pools.primaryPool);
      const identity = await repository.reserve(
        { ownerId: userId, domain: 'competitor', kind: 'write' },
        (unit) => authorizeAdministration(unit, principal, 'asin:write'),
      );
      // Keep the production wrapper's default 4000/1500 ms limits. Its actual
      // primary guard and competitor write remain uncommitted behind this gate.
      const heldRepository = new PgCompetitorWriteRepository(
        f.pools.primaryPool,
        f.pools.competitorPool,
      );
      const httpRepository = f.app.get<CompetitorWriteRepositoryPort>(
        COMPETITOR_WRITE_REPOSITORY,
      );
      const secondAction = vi.spyOn(httpRepository, 'transaction');
      const catalogAdmission = vi.spyOn(
        f.app.get(ApplicationCatalogOperations),
        'execute',
      );
      let proceed!: () => void,
        ready!: () => void,
        holding = false;
      const gate = new Promise<void>((resolve) => {
        proceed = resolve;
      });
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const business = withCatalogOperationExecution(repository, identity, () =>
        heldRepository.transaction(async (unit) => {
          await authorizeAdministration(unit, principal, 'asin:write');
          const result = await unit.updateGroup(groupId, {
            ...payload,
            name: 'First committed edit',
          });
          holding = true;
          ready();
          await gate;
          holding = false;
          return result;
        }),
      );
      const physicalSnapshot = async () => ({
        slots: (
          await f.pools.primaryPool.query(
            'SELECT * FROM catalog_operation_slots WHERE owner_id=$1 ORDER BY domain',
            [userId],
          )
        ).rows,
        pins: (
          await f.pools.primaryPool.query(
            'SELECT * FROM catalog_operation_pins WHERE owner_id=$1 ORDER BY pin_id',
            [userId],
          )
        ).rows,
        groups: (
          await f.pools.competitorPool.query(
            'SELECT * FROM competitor_variant_groups ORDER BY id',
          )
        ).rows,
        asins: (
          await f.pools.competitorPool.query(
            'SELECT * FROM competitor_asins ORDER BY id',
          )
        ).rows,
        history: (
          await f.pools.competitorPool.query(
            'SELECT * FROM competitor_monitor_history ORDER BY id',
          )
        ).rows,
      });
      try {
        await Promise.race([
          started,
          business.then(() => {
            throw new Error(
              'Business transaction ended before the held-lock oracle',
            );
          }),
        ]);
        const before = await physicalSnapshot();
        const snapshot = await repository.read(userId, 'competitor');
        expect(snapshot).toMatchObject({
          ...identity,
          state: 'open',
          pendingPins: 1,
          uncertainPins: 0,
        });
        expect(before.groups.find((row) => row.id === groupId)?.name).toBe(
          payload.name,
        );
        const changed = await f.http.inject({
          method: 'PUT',
          url: `/api/v1/competitor/variant-groups/${encodeURIComponent(
            groupId,
          )}`,
          headers: requestHeaders,
          payload: { ...payload, name: 'Unexpected second edit' },
        });
        expect(changed.statusCode).toBe(expectedStatus);
        expect(changed.json()).toMatchObject({
          success: false,
          errorCode: expectedStatus,
        });
        expect(catalogAdmission).toHaveBeenCalledTimes(separateSession ? 1 : 0);
        if (!separateSession)
          expect(changed.json().errorMessage).toBe('鉴权服务暂时不可用');
        for (const secret of [
          identity.operationId,
          'catalog_operation_slots',
          '57014',
          '55P03',
        ])
          expect(changed.body).not.toContain(secret);
        expect(holding).toBe(true);
        expect(secondAction).not.toHaveBeenCalled();
        expect(await repository.read(userId, 'competitor')).toEqual(snapshot);
        expect(await physicalSnapshot()).toEqual(before);
        proceed();
        await business;
        expect(await repository.read(userId, 'competitor')).toMatchObject({
          ...identity,
          pendingPins: 0,
          uncertainPins: 0,
        });
        expect(
          (
            await f.pools.competitorPool.query(
              'SELECT name FROM competitor_variant_groups WHERE id=$1',
              [groupId],
            )
          ).rows[0].name,
        ).toBe('First committed edit');
        await repository.close(identity, {
          status: 'completed',
          source: 'sync',
        });
        expect(await repository.release(identity)).toBe(true);
        const next = await f.http.inject({
          method: 'PUT',
          url: `/api/v1/competitor/variant-groups/${encodeURIComponent(
            groupId,
          )}`,
          headers: requestHeaders,
          payload: { ...payload, name: 'Verified next edit' },
        });
        expect(next.statusCode).toBe(200);
        expect(next.json().data.name).toBe('Verified next edit');
        expect(await repository.read(userId, 'competitor')).toBeNull();
      } finally {
        proceed();
        try {
          await Promise.allSettled([business]);
          // An outer timeout is not physical settlement. Await the actual wrapper
          // and persisted pin before the fixture is allowed to drop its schemas.
          await vi.waitFor(
            async () => {
              expect(heldRepository.getDiagnostics().pendingOperations).toBe(0);
              const current = await repository.read(userId, 'competitor');
              expect(current?.pendingPins ?? 0).toBe(0);
            },
            { timeout: 1000, interval: 10 },
          );
        } finally {
          heldRepository.close();
          secondAction.mockRestore();
          catalogAdmission.mockRestore();
        }
      }
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
