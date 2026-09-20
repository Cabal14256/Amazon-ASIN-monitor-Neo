import {
  competitorGroupListResultSchema,
  competitorGroupResultSchema,
} from '@asin-monitor/contracts';
import {
  CompetitorQueryError,
  type AuthSessionRecord,
  type AuthUserRecord,
  type CompetitorGroupReadResult,
  type CompetitorQueryRepositoryPort,
  type CompetitorQueryUnit,
} from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPETITOR_QUERY_REPOSITORY } from '../src/competitor/competitor-query.service';
import { CompetitorModule } from '../src/competitor/competitor.module';
import {
  competitorQueryAsin,
  competitorQueryGroup,
} from './helpers/competitor-query-fixtures';
import { sessionApp } from './helpers/session-app';

const id = 'operator-119',
  sessionId = 'session-119';
function fixture() {
  const user: AuthUserRecord = {
    id,
    username: id,
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
    id: sessionId,
    userId: id,
    userAgent: null,
    ipAddress: null,
    status: 'ACTIVE',
    rememberMe: false,
    createdAt: new Date(),
    lastActiveAt: new Date(),
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  };
  const permissions = ['asin:read'];
  const result: CompetitorGroupReadResult = {
    groups: [{ ...competitorQueryGroup(), asinCount: 1 }],
    asins: [competitorQueryAsin()],
    total: 1,
    totalASINs: 1,
  };
  const unit: CompetitorQueryUnit = {
    lockOperator: vi.fn(async () => user),
    lockSession: vi.fn(async () => session),
    operatorPermissionCodes: vi.fn(async () => permissions),
    list: vi.fn(async () => result),
    detail: vi.fn(async () => ({
      ...result,
      groups: [competitorQueryGroup()],
    })),
  };
  const repository: CompetitorQueryRepositoryPort = {
    read: vi.fn(async (action) => action(unit)),
    close: vi.fn(),
  };
  const auth = {
    findUserById: vi.fn(async () =>
      structuredClone({
        ...user,
        status: 'ACTIVE',
        forcePasswordChange: false,
        passwordExpiresAt: null,
      }),
    ),
    findSessionById: vi.fn(async () =>
      structuredClone({
        ...session,
        status: 'ACTIVE',
        expiresAt: new Date('2099-01-01T00:00:00Z'),
      }),
    ),
    getPermissionCodes: vi.fn(async () => ['asin:read']),
    getRoles: vi.fn(async () => [
      { id: 'reader-119', code: 'READONLY', name: 'Fixture' },
    ]),
    touchSession: vi.fn(),
    revokeSession: vi.fn(),
    markPasswordChangeRequired: vi.fn(),
    listSessionsByUserId: vi.fn(async () => []),
    revokeOwnedSession: vi.fn(async () => true),
  };
  return { user, session, permissions, result, unit, repository, auth };
}
describe('competitor query HTTP / current authorization and full contracts', () => {
  let f: ReturnType<typeof fixture>,
    app: Awaited<ReturnType<typeof sessionApp>>,
    headers: { authorization: string };
  const paths = [
    '/competitor/variant-groups',
    '/competitor/variant-groups/group-119',
  ];
  async function start(overrides: NodeJS.ProcessEnv = {}) {
    app = await sessionApp(
      f.auth,
      overrides,
      (builder) =>
        builder
          .overrideProvider(COMPETITOR_QUERY_REPOSITORY)
          .useValue(f.repository),
      [CompetitorModule],
    );
    headers = {
      authorization: `Bearer ${jwt.sign(
        { userId: id, sessionId },
        app.env.JWT_SECRET,
        { expiresIn: '1h' },
      )}`,
    };
  }
  beforeEach(async () => {
    f = fixture();
    await start();
  });
  afterEach(async () => {
    await app.app.close();
    vi.restoreAllMocks();
  });
  const get = (path: string, auth = headers) =>
    app.http.inject({ method: 'GET', url: `/api/v1${path}`, headers: auth });
  it.each(paths)(
    'requires login for %s before opening a transaction',
    async (path) => {
      expect((await get(path, {} as never)).statusCode).toBe(401);
      expect(f.repository.read).not.toHaveBeenCalled();
    },
  );
  it.each(paths)(
    'returns the complete competitor contract with no-store for %s',
    async (path) => {
      const response = await get(path);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      (path === paths[0]
        ? competitorGroupListResultSchema
        : competitorGroupResultSchema
      ).parse(response.json());
      const group =
        path === paths[0] ? response.json().data.list[0] : response.json().data;
      expect(group.feishuNotifyEnabled).toBe(0);
      expect(group).not.toHaveProperty('site');
      expect(group.children[0]).not.toHaveProperty('manualBroken');
    },
  );
  it.each(['BROKEN', 'NORMAL', 'broken', 'unexpected', ''])(
    'keeps Legacy nonempty status normalization (%s)',
    async (value) => {
      const response = await get(
        `${paths[0]}?current=2&pageSize=50&keyword=a%25_b&country=us%20&variantStatus=${value}`,
      );
      expect(response.statusCode).toBe(200);
      expect(f.unit.list).toHaveBeenCalledWith({
        current: 2,
        pageSize: 50,
        keyword: 'a%_b',
        country: 'us ',
        variantStatus: value
          ? value === 'BROKEN'
            ? 'BROKEN'
            : 'NORMAL'
          : undefined,
      });
    },
  );
  it.each([
    '?pageSize=101',
    '?current=-1',
    '?country=US&country=UK',
    '?current=1000002',
    '/' + 'x'.repeat(51),
  ])('rejects invalid input %s before competitor access', async (suffix) => {
    expect((await get(paths[0] + suffix)).statusCode).toBe(400);
    expect(f.unit.list).not.toHaveBeenCalled();
    expect(f.unit.detail).not.toHaveBeenCalled();
  });
  it.each(paths)(
    'rejects current permission revocation despite guard grants on %s',
    async (path) => {
      f.permissions.splice(0);
      expect((await get(path)).statusCode).toBe(403);
      expect(f.unit.list).not.toHaveBeenCalled();
      expect(f.unit.detail).not.toHaveBeenCalled();
    },
  );
  it.each(['user', 'password', 'password-expiry', 'session', 'session-expiry'])(
    'rechecks current %s in the primary transaction',
    async (kind) => {
      if (kind === 'user') f.user.status = 'DISABLED';
      if (kind === 'password') f.user.forcePasswordChange = true;
      if (kind === 'password-expiry') f.user.passwordExpiresAt = new Date(0);
      if (kind === 'session') f.session.status = 'REVOKED';
      if (kind === 'session-expiry') f.session.expiresAt = new Date(0);
      expect((await get(paths[0])).statusCode).toBe(403);
      expect(f.unit.list).not.toHaveBeenCalled();
    },
  );
  it('rejects missing guard permission before transaction access', async () => {
    f.auth.getPermissionCodes.mockResolvedValue([]);
    expect((await get(paths[0])).statusCode).toBe(403);
    expect(f.repository.read).not.toHaveBeenCalled();
  });
  it('keeps the competitor-specific missing group response', async () => {
    vi.mocked(f.unit.detail).mockResolvedValue({
      groups: [],
      asins: [],
      total: 0,
      totalASINs: 0,
    });
    const response = await get(paths[1]);
    expect(response.statusCode).toBe(404);
    expect(response.json().errorMessage).toBe('竞品变体组不存在');
  });
  it.each([
    ['capacity', 429],
    ['too-many-children', 413],
    ['timeout', 500],
    ['dependency', 500],
  ] as const)(
    'maps %s without returning partial data',
    async (code, status) => {
      vi.mocked(f.repository.read).mockRejectedValue(
        new CompetitorQueryError(code),
      );
      const response = await get(paths[0]);
      expect(response.statusCode).toBe(status);
      expect(response.json().data).toBeUndefined();
    },
  );
  it('keeps raw driver values out of responses and logs', async () => {
    vi.mocked(f.repository.read).mockRejectedValue(
      new Error('private-fixture-driver-value'),
    );
    const response = await get(paths[0]);
    expect(response.statusCode).toBe(500);
    expect(
      response.body + JSON.stringify(app.logger.error.mock.calls),
    ).not.toContain('private-fixture');
  });
  it('closes the owned query reader on application shutdown', async () => {
    await app.app.close();
    expect(f.repository.close).toHaveBeenCalled();
  });
  it('fails before PostgreSQL authority is enabled', async () => {
    await app.app.close();
    f = fixture();
    await start({
      AUTH_DATA_AUTHORITY: 'legacy-mysql',
      DB_HOST: 'localhost',
      DB_USER: 'fixture',
      DB_PASSWORD: 'fixture',
      DB_NAME: 'fixture',
    });
    expect((await get(paths[0])).statusCode).toBe(503);
    expect(f.repository.read).not.toHaveBeenCalled();
  });
});
