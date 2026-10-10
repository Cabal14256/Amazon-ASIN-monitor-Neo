import {
  competitorGroupResultSchema,
  isNeoBatchDeleteId,
  variantGroupResultSchema,
} from '@asin-monitor/contracts';
import type {
  AsinQueryRepositoryPort,
  AsinQueryUnit,
  AuthSessionRecord,
  AuthUserRecord,
  CompetitorQueryRepositoryPort,
  CompetitorQueryUnit,
} from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASIN_QUERY_REPOSITORY } from '../src/asin/asin-query.service';
import { AsinModule } from '../src/asin/asin.module';
import { COMPETITOR_QUERY_REPOSITORY } from '../src/competitor/competitor-query.service';
import { CompetitorModule } from '../src/competitor/competitor.module';
import { queryAsin, queryGroup } from './helpers/asin-query-fixtures';
import {
  competitorQueryAsin,
  competitorQueryGroup,
} from './helpers/competitor-query-fixtures';
import { sessionApp } from './helpers/session-app';

const samples = [
  'group-normal',
  ' Source Ś ',
  ' ',
  '.',
  '..',
  'a/b',
  'a?b',
  'a#b',
  'a\\b',
  '中文🔎',
  '🔎'.repeat(50),
  'a%b',
  'a+b',
  'a=b',
  'a,b',
];
const badQueries = [
  '',
  'groupId=',
  'groupId=Raw&groupId=Other',
  'groupId%5Bx%5D=Raw',
  'groupId=Raw&other=value',
  ...['\u0000', '\n', '\u007f', '\u0085', '\u009f', '🔎'.repeat(51)].map((id) =>
    new URLSearchParams({ groupId: id }).toString(),
  ),
  'groupId=%ED%A0%80',
  'groupId=%C0%AF',
  'groupId=%E0%A4%A',
  'groupId=%',
];

function fixture(domain: 'primary' | 'competitor') {
  const user: AuthUserRecord = {
    id: 'operator-242',
    username: 'synthetic-operator-242',
    realName: null,
    status: 'ACTIVE',
    lastLoginTime: null,
    lastLoginIp: null,
    passwordExpiresAt: null,
    passwordChangedAt: null,
    forcePasswordChange: false,
    failedLoginAttempts: 0,
    lockedUntil: null,
    createTime: null,
    updateTime: null,
  };
  const session: AuthSessionRecord = {
    id: 'session-242',
    userId: user.id,
    userAgent: null,
    ipAddress: null,
    status: 'ACTIVE',
    rememberMe: false,
    createdAt: new Date(),
    lastActiveAt: new Date(),
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  };
  const permissions = ['asin:read'];
  const detail = vi.fn(async (id: string) =>
    domain === 'primary'
      ? {
          groups: [queryGroup({ id })],
          asins: [queryAsin({ id: ' literal child /?# ', variantGroupId: id })],
          total: 0,
          totalASINs: 0,
        }
      : {
          groups: [competitorQueryGroup({ id })],
          asins: [
            competitorQueryAsin({
              id: ' literal child /?# ',
              variantGroupId: id,
            }),
          ],
          total: 0,
          totalASINs: 0,
        },
  );
  const unit = {
    lockOperator: vi.fn(async () => user),
    lockSession: vi.fn(async () => session as AuthSessionRecord | undefined),
    operatorPermissionCodes: vi.fn(async () => permissions),
    list: vi.fn(),
    detail,
  };
  const repository = {
    read: vi.fn(
      async <T>(
        action: (value: AsinQueryUnit | CompetitorQueryUnit) => Promise<T>,
      ) => action(unit as unknown as AsinQueryUnit | CompetitorQueryUnit),
    ),
    close: vi.fn(),
  };
  // The guard sees the established cached identity; transaction authorization
  // uses the independently mutable current user, session and permissions above.
  const auth = {
    findUserById: vi.fn(async () =>
      structuredClone({
        ...user,
        status: 'ACTIVE' as const,
        forcePasswordChange: false,
        passwordExpiresAt: null,
      }),
    ),
    findSessionById: vi.fn(async () =>
      structuredClone({
        ...session,
        status: 'ACTIVE' as const,
        expiresAt: new Date('2099-01-01T00:00:00Z'),
      }),
    ),
    getPermissionCodes: vi.fn(async () => ['asin:read']),
    getRoles: vi.fn(async () => [
      { id: 'reader-242', code: 'READONLY', name: 'Fixture' },
    ]),
    touchSession: vi.fn(),
    revokeSession: vi.fn(),
    markPasswordChangeRequired: vi.fn(),
    listSessionsByUserId: vi.fn(async () => []),
    revokeOwnedSession: vi.fn(async () => true),
  };
  return { user, session, permissions, unit, repository, auth };
}

describe.each(['primary', 'competitor'] as const)(
  '%s actual Fastify Neo literal detail query',
  (domain) => {
    let f: ReturnType<typeof fixture>,
      app: Awaited<ReturnType<typeof sessionApp>>,
      headers: { authorization: string };
    const route =
      domain === 'primary'
        ? '/api/v1/catalog/variant-groups/detail'
        : '/api/v1/competitor/catalog/variant-groups/detail';
    const oldRoute =
      domain === 'primary'
        ? '/api/v1/variant-groups'
        : '/api/v1/competitor/variant-groups';
    beforeEach(async () => {
      f = fixture(domain);
      app = await sessionApp(
        f.auth,
        {},
        (builder) =>
          domain === 'primary'
            ? builder
                .overrideProvider(ASIN_QUERY_REPOSITORY)
                .useValue(f.repository as unknown as AsinQueryRepositoryPort)
            : builder
                .overrideProvider(COMPETITOR_QUERY_REPOSITORY)
                .useValue(
                  f.repository as unknown as CompetitorQueryRepositoryPort,
                ),
        domain === 'primary' ? [AsinModule] : [CompetitorModule],
      );
      headers = {
        authorization: `Bearer ${jwt.sign(
          { userId: f.user.id, sessionId: f.session.id },
          app.env.JWT_SECRET,
          { expiresIn: '1h' },
        )}`,
      };
    });
    afterEach(async () => {
      await app?.app.close();
      vi.restoreAllMocks();
    });
    const get = (query: string, auth = headers) =>
      app.http.inject({
        method: 'GET',
        url: `${route}?${query}`,
        headers: auth,
      });
    it.each(samples)(
      'passes original %j through guards, current authorization, service and mapper',
      async (id) => {
        expect(isNeoBatchDeleteId(id)).toBe(true);
        const response = await get(
          new URLSearchParams({ groupId: id }).toString(),
        );
        expect(response.statusCode).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        (domain === 'primary'
          ? variantGroupResultSchema
          : competitorGroupResultSchema
        ).parse(response.json());
        expect(response.json().data).toMatchObject({
          id,
          children: [{ id: ' literal child /?# ', parentId: id }],
        });
        expect(f.unit.detail).toHaveBeenCalledTimes(1);
        expect(f.unit.detail.mock.calls[0][0]).toBe(id);
        expect(f.unit.lockOperator).toHaveBeenCalledWith(f.user.id);
        expect(f.unit.lockSession).toHaveBeenCalledWith(
          f.user.id,
          f.session.id,
        );
        expect(f.unit.operatorPermissionCodes).toHaveBeenCalledWith(f.user.id);
      },
    );
    it.each(badQueries)(
      'rejects malformed or ambiguous wire query %j before business detail',
      async (query) => {
        expect((await get(query)).statusCode).toBe(400);
        expect(f.unit.detail).not.toHaveBeenCalled();
        expect(f.unit.list).not.toHaveBeenCalled();
      },
    );
    it('requires login before opening a transaction', async () => {
      expect((await get('groupId=Raw', {} as never)).statusCode).toBe(401);
      expect(f.repository.read).not.toHaveBeenCalled();
    });
    it('denies a guard identity without asin:read before data access', async () => {
      f.auth.getPermissionCodes.mockResolvedValue([]);
      expect((await get('groupId=Raw')).statusCode).toBe(403);
      expect(f.repository.read).not.toHaveBeenCalled();
    });
    it.each([
      'permissions',
      'disabled-user',
      'password-change',
      'revoked-session',
      'expired-session',
      'foreign-session',
    ] as const)(
      'uses current transaction %s despite the cached guard identity',
      async (field) => {
        if (field === 'permissions') f.permissions.splice(0);
        if (field === 'disabled-user') f.user.status = 'DISABLED';
        if (field === 'password-change') f.user.forcePasswordChange = true;
        if (field === 'revoked-session') f.session.status = 'REVOKED';
        if (field === 'expired-session') f.session.expiresAt = new Date(0);
        if (field === 'foreign-session')
          f.unit.lockSession.mockResolvedValueOnce(undefined);
        expect((await get('groupId=Raw')).statusCode).toBe(403);
        expect(f.unit.detail).not.toHaveBeenCalled();
      },
    );
    it('keeps the missing-group 404 and hides private dependency failures', async () => {
      f.unit.detail.mockResolvedValueOnce({
        groups: [],
        asins: [],
        total: 0,
        totalASINs: 0,
      });
      expect((await get('groupId=missing')).statusCode).toBe(404);
      f.repository.read.mockRejectedValueOnce(
        new Error('fixture-private-database-error'),
      );
      const response = await get('groupId=Raw');
      expect(response.statusCode).toBe(500);
      expect(
        response.body + JSON.stringify(app.logger.error.mock.calls),
      ).not.toContain('fixture-private-database-error');
    });
    it.each(['detail', 'by-id', ' Source Ś ', '中文🔎'])(
      'retains the existing path detail for the real old ID %j',
      async (id) => {
        const response = await app.http.inject({
          method: 'GET',
          url: `${oldRoute}/${encodeURIComponent(id)}`,
          headers,
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().data.id).toBe(id);
        expect(f.unit.detail.mock.calls[0][0]).toBe(id);
      },
    );
  },
);
