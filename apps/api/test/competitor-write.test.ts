import {
  competitorAsinRecordResultSchema,
  competitorGroupResultSchema,
} from '@asin-monitor/contracts';
import {
  CompetitorQueryError,
  CompetitorTransactionError,
  CompetitorWriteError,
  type AuthSessionRecord,
  type AuthUserRecord,
  type CompetitorWriteRepositoryPort,
  type CompetitorWriteUnit,
} from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPETITOR_WRITE_REPOSITORY } from '../src/competitor/competitor-write.service';
import { CompetitorModule } from '../src/competitor/competitor.module';
import {
  competitorQueryAsin,
  competitorQueryGroup,
} from './helpers/competitor-query-fixtures';
import { sessionApp } from './helpers/session-app';

const id = 'operator-121',
  sessionId = 'session-121';
const groupBody = { name: 'Group', country: ' us ', brand: 'Brand' };
const asinBody = {
  asin: ' b000000121 ',
  country: ' us ',
  brand: 'Own brand',
  asinType: 2,
};
const cases = [
  {
    method: 'POST',
    url: '/competitor/variant-groups',
    body: groupBody,
    action: 'createGroup',
  },
  {
    method: 'PUT',
    url: '/competitor/variant-groups/group-119',
    body: groupBody,
    action: 'updateGroup',
  },
  {
    method: 'POST',
    url: '/competitor/asins',
    body: { ...asinBody, parentId: 'group-119' },
    action: 'createAsin',
  },
  {
    method: 'PUT',
    url: '/competitor/asins/asin-119',
    body: asinBody,
    action: 'updateAsin',
  },
  {
    method: 'POST',
    url: '/competitor/asins/asin-119/move',
    body: { targetGroupId: 'group-target' },
    action: 'moveAsin',
  },
] as const;
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
  const permissions = ['asin:write'];
  const result = {
    groups: [competitorQueryGroup()],
    asins: [competitorQueryAsin()],
    total: 0,
    totalASINs: 0,
  };
  const unit: CompetitorWriteUnit = {
    lockOperator: vi.fn(async () => user),
    lockSession: vi.fn(async () => session),
    operatorPermissionCodes: vi.fn(async () => permissions),
    createGroup: vi.fn(async () => result),
    updateGroup: vi.fn(async () => result),
    createAsin: vi.fn(async () => competitorQueryAsin()),
    updateAsin: vi.fn(async () => competitorQueryAsin()),
    moveAsin: vi.fn(async () => competitorQueryAsin()),
  };
  const repository: CompetitorWriteRepositoryPort = {
    transaction: vi.fn(async (action) => action(unit)),
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
    getPermissionCodes: vi.fn(async () => ['asin:write']),
    getRoles: vi.fn(async () => [
      { id: 'writer-121', code: 'ADMIN', name: 'Fixture' },
    ]),
    touchSession: vi.fn(),
    revokeSession: vi.fn(),
    markPasswordChangeRequired: vi.fn(),
    listSessionsByUserId: vi.fn(async () => []),
    revokeOwnedSession: vi.fn(async () => true),
  };
  return { user, session, permissions, result, unit, repository, auth };
}
describe('competitor writes HTTP / current primary authorization', () => {
  let f: ReturnType<typeof fixture>,
    app: Awaited<ReturnType<typeof sessionApp>>,
    headers: { authorization: string };
  async function start(overrides: NodeJS.ProcessEnv = {}) {
    app = await sessionApp(
      f.auth,
      overrides,
      (builder) =>
        builder
          .overrideProvider(COMPETITOR_WRITE_REPOSITORY)
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
  const request = (
    value: (typeof cases)[number],
    auth = headers,
    body: unknown = value.body,
  ) =>
    app.http.inject({
      method: value.method,
      url: `/api/v1${value.url}`,
      headers: auth,
      payload: body as Record<string, unknown>,
    });
  it.each(cases)('requires authentication for $method $url', async (value) => {
    expect((await request(value, {} as never)).statusCode).toBe(401);
    expect(f.repository.transaction).not.toHaveBeenCalled();
  });
  it.each(cases)(
    'returns the complete result and no-store for $method $url',
    async (value) => {
      const result = await request(value);
      expect(result.statusCode).toBe(200);
      expect(result.headers['cache-control']).toBe('no-store');
      (value.action.endsWith('Group')
        ? competitorGroupResultSchema
        : competitorAsinRecordResultSchema
      ).parse(result.json());
      expect(result.json().data).not.toHaveProperty('site');
      expect(f.unit[value.action]).toHaveBeenCalledOnce();
      expect(f.unit.lockOperator).toHaveBeenCalledWith(id);
      expect(f.unit.lockSession).toHaveBeenCalledWith(id, sessionId);
    },
  );
  it.each(cases)(
    'rejects committed permission revocation for $action despite cached guard grants',
    async (value) => {
      f.permissions.splice(0);
      expect((await request(value)).statusCode).toBe(403);
      expect(f.unit[value.action]).not.toHaveBeenCalled();
    },
  );
  it.each(cases)(
    'rejects an unexpected Origin before transaction on $action',
    async (value) => {
      expect(
        (
          await request(value, {
            ...headers,
            origin: 'https://untrusted.invalid',
          } as typeof headers)
        ).statusCode,
      ).toBe(403);
      expect(f.repository.transaction).not.toHaveBeenCalled();
    },
  );
  it.each(['user', 'password', 'password-expiry', 'session', 'session-expiry'])(
    'rejects current %s state',
    async (kind) => {
      if (kind === 'user') f.user.status = 'DISABLED';
      if (kind === 'password') f.user.forcePasswordChange = true;
      if (kind === 'password-expiry') f.user.passwordExpiresAt = new Date(0);
      if (kind === 'session') f.session.status = 'REVOKED';
      if (kind === 'session-expiry') f.session.expiresAt = new Date(0);
      expect((await request(cases[2])).statusCode).toBe(403);
      expect(f.unit.createAsin).not.toHaveBeenCalled();
    },
  );
  it('normalizes accepted fields before handing them to the competitor transaction', async () => {
    await request(cases[0]);
    await request(cases[2]);
    await request(cases[4]);
    expect(f.unit.createGroup).toHaveBeenCalledWith({
      name: 'Group',
      country: 'US',
      brand: 'Brand',
    });
    expect(f.unit.createAsin).toHaveBeenCalledWith({
      asin: 'B000000121',
      country: 'US',
      brand: 'Own brand',
      asinType: '2',
      name: null,
      parentId: 'group-119',
    });
    expect(f.unit.moveAsin).toHaveBeenCalledWith('asin-119', 'group-target');
  });
  it.each(cases)(
    'rejects invalid bodies without writes on $action',
    async (value) => {
      expect(
        (await request(value, headers, { privateField: 'invalid' })).statusCode,
      ).toBe(400);
      expect(f.unit[value.action]).not.toHaveBeenCalled();
    },
  );
  it.each([
    [new CompetitorWriteError('group-not-found'), 404],
    [new CompetitorWriteError('asin-not-found'), 404],
    [new CompetitorWriteError('validation', '所属竞品变体组不存在'), 400],
    [new CompetitorWriteError('parent-changed'), 409],
    [new CompetitorWriteError('duplicate'), 409],
    [new CompetitorWriteError('timestamp-policy'), 503],
    [new CompetitorQueryError('too-many-children'), 413],
    [new CompetitorTransactionError('capacity'), 429],
    [new CompetitorTransactionError('timeout'), 500],
    [new CompetitorTransactionError('commit-uncertain'), 503],
  ] as const)('returns an explicit failure for %s', async (error, status) => {
    vi.mocked(f.repository.transaction).mockRejectedValue(error);
    const result = await request(cases[0]);
    expect(result.statusCode).toBe(status);
    expect(result.json().data).toBeUndefined();
    if (
      error instanceof CompetitorTransactionError &&
      error.code === 'commit-uncertain'
    )
      expect(result.body).toContain('刷新数据后再操作');
  });
  it('does not expose driver payloads in errors or operational logs', async () => {
    vi.mocked(f.repository.transaction).mockRejectedValue(
      new Error('private-sql-credential'),
    );
    const result = await request(cases[0]);
    expect(result.statusCode).toBe(500);
    expect(
      result.body + JSON.stringify(app.logger.error.mock.calls),
    ).not.toContain('private-sql');
  });
  it('checks guard permissions before acquiring a transaction', async () => {
    f.auth.getPermissionCodes.mockResolvedValue([]);
    expect((await request(cases[0])).statusCode).toBe(403);
    expect(f.repository.transaction).not.toHaveBeenCalled();
  });
  it('closes the writer on host shutdown', async () => {
    await app.app.close();
    expect(f.repository.close).toHaveBeenCalled();
  });
  it('rejects writes until PostgreSQL is the authority', async () => {
    await app.app.close();
    await start({
      AUTH_DATA_AUTHORITY: 'legacy-mysql',
      DB_HOST: 'localhost',
      DB_USER: 'fixture',
      DB_PASSWORD: 'fixture',
      DB_NAME: 'fixture',
    });
    expect((await request(cases[0])).statusCode).toBe(503);
    expect(f.repository.transaction).not.toHaveBeenCalled();
  });
});
