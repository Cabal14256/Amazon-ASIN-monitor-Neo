import {
  variantGroupListResultSchema,
  variantGroupResultSchema,
} from '@asin-monitor/contracts';
import {
  AsinQueryRepositoryError,
  type AsinGroupReadResult,
  type AsinQueryRepositoryPort,
  type AsinQueryUnit,
  type AuthSessionRecord,
  type AuthUserRecord,
} from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASIN_QUERY_REPOSITORY } from '../src/asin/asin-query.service';
import { AsinModule } from '../src/asin/asin.module';
import { queryAsin, queryGroup } from './helpers/asin-query-fixtures';
import { sessionApp } from './helpers/session-app';

const id = 'operator-83',
  sessionId = 'session-83';
function data() {
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
  const result: AsinGroupReadResult = {
    groups: [{ ...queryGroup(), asinCount: 1 }],
    asins: [queryAsin()],
    total: 1,
    totalASINs: 1,
  };
  const unit = {
    lockOperator: vi.fn(async () => user),
    lockSession: vi.fn(async () => session),
    operatorPermissionCodes: vi.fn(async () => permissions),
    list: vi.fn(async () => result),
    detail: vi.fn(async () => ({ ...result, groups: [queryGroup()] })),
  } as unknown as AsinQueryUnit;
  const repository: AsinQueryRepositoryPort = {
    read: vi.fn(async (operation) => operation(unit)),
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
      { id: 'reader-83', code: 'READONLY', name: 'Fixture' },
    ]),
    touchSession: vi.fn(),
    revokeSession: vi.fn(),
    markPasswordChangeRequired: vi.fn(),
    listSessionsByUserId: vi.fn(async () => []),
    revokeOwnedSession: vi.fn(async () => true),
  };
  return { user, session, permissions, result, unit, repository, auth };
}
describe('ASIN group HTTP queries / current transaction authorization', () => {
  let f: ReturnType<typeof data>,
    app: Awaited<ReturnType<typeof sessionApp>>,
    headers: { authorization: string };
  const paths = ['/variant-groups', '/variant-groups/group-83'];
  async function start(overrides: NodeJS.ProcessEnv = {}) {
    app = await sessionApp(
      f.auth,
      overrides,
      (builder) =>
        builder.overrideProvider(ASIN_QUERY_REPOSITORY).useValue(f.repository),
      [AsinModule],
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
    f = data();
    await start();
  });
  afterEach(async () => {
    await app.app.close();
    vi.restoreAllMocks();
  });
  const get = (path: string, auth = headers) =>
    app.http.inject({ method: 'GET', url: `/api/v1${path}`, headers: auth });
  it.each(paths)('requires login on %s', async (path) => {
    expect((await get(path, {} as never)).statusCode).toBe(401);
    expect(f.repository.read).not.toHaveBeenCalled();
  });
  it.each(paths)(
    'allows asin:read and returns the frozen envelope with no-store on %s',
    async (path) => {
      const response = await get(path);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      (path === paths[0]
        ? variantGroupListResultSchema
        : variantGroupResultSchema
      ).parse(response.json());
    },
  );
  it('passes normalized pagination with literal filters to the transaction unit', async () => {
    expect(
      (
        await get(
          '/variant-groups?current=2&pageSize=50&keyword=B000&country=US&variantStatus=BROKEN',
        )
      ).statusCode,
    ).toBe(200);
    expect(f.unit.list).toHaveBeenCalledWith({
      current: 2,
      pageSize: 50,
      keyword: 'B000',
      country: 'US',
      variantStatus: 'BROKEN',
    });
  });
  it.each([
    '/variant-groups?pageSize=101',
    '/variant-groups?current=-1',
    '/variant-groups?variantStatus=bad',
    '/variant-groups?country=US&country=UK',
    '/variant-groups/' + 'x'.repeat(51),
  ])('rejects invalid query %s before data access', async (path) => {
    expect((await get(path)).statusCode).toBe(400);
    expect(f.unit.list).not.toHaveBeenCalled();
    expect(f.unit.detail).not.toHaveBeenCalled();
  });
  it.each(paths)(
    'rejects fresh permission revocation despite guard cache on %s',
    async (path) => {
      f.permissions.splice(0);
      expect((await get(path)).statusCode).toBe(403);
      expect(f.unit.list).not.toHaveBeenCalled();
      expect(f.unit.detail).not.toHaveBeenCalled();
    },
  );
  it.each(['user', 'password', 'password-expiry', 'session', 'session-expiry'])(
    'checks current %s inside the transaction',
    async (field) => {
      if (field === 'user') f.user.status = 'DISABLED';
      if (field === 'password') f.user.forcePasswordChange = true;
      if (field === 'password-expiry') f.user.passwordExpiresAt = new Date(0);
      if (field === 'session') f.session.status = 'REVOKED';
      if (field === 'session-expiry') f.session.expiresAt = new Date(0);
      expect((await get(paths[0])).statusCode).toBe(403);
      expect(f.unit.list).not.toHaveBeenCalled();
    },
  );
  it('rejects a caller missing asin:read before starting a data transaction', async () => {
    f.auth.getPermissionCodes.mockResolvedValue([]);
    expect((await get(paths[0])).statusCode).toBe(403);
    expect(f.repository.read).not.toHaveBeenCalled();
  });
  it('returns the existing 404 for a missing group', async () => {
    vi.mocked(f.unit.detail).mockResolvedValueOnce({
      groups: [],
      asins: [],
      total: 0,
      totalASINs: 0,
    });
    const response = await get(paths[1]);
    expect(response.statusCode).toBe(404);
    expect(response.json().errorMessage).toBe('变体组不存在');
  });
  it('fails the entire response when its children exceed the bound', async () => {
    vi.mocked(f.unit.list).mockRejectedValueOnce(
      new AsinQueryRepositoryError('too-many-children'),
    );
    const response = await get(paths[0]);
    expect(response.statusCode).toBe(413);
    expect(response.json().data).toBeUndefined();
  });
  it('keeps driver errors out of logs and HTTP responses', async () => {
    vi.mocked(f.repository.read).mockRejectedValueOnce(
      new Error('postgresql://fixture-private/password'),
    );
    const response = await get(paths[0]);
    expect(response.statusCode).toBe(500);
    expect(response.json().errorMessage).toBe('服务器内部错误');
    expect(
      response.body + JSON.stringify(app.logger.error.mock.calls),
    ).not.toContain('fixture-private');
  });
  it('bounds eight active reads and restores admission on actual completion', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(f.repository.read).mockImplementation(async (operation) => {
      await gate;
      return operation(f.unit);
    });
    const pending = Array.from({ length: 8 }, () =>
      Promise.resolve(get(paths[0])),
    );
    try {
      await vi.waitFor(() =>
        expect(f.repository.read).toHaveBeenCalledTimes(8),
      );
      expect((await get(paths[0])).statusCode).toBe(429);
    } finally {
      release();
      await Promise.allSettled(pending);
    }
    expect((await get(paths[0])).statusCode).toBe(200);
  });
  it('rejects the Neo data path before a PostgreSQL authority switch', async () => {
    await app.app.close();
    f = data();
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
