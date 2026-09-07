import {
  asinRecordResultSchema,
  variantGroupResultSchema,
} from '@asin-monitor/contracts';
import {
  AsinQueryRepositoryError,
  AsinTimestampPolicyError,
  AsinWriteRepositoryError,
  type AsinWriteRepositoryPort,
  type AsinWriteUnit,
  type AuthSessionRecord,
  type AuthUserRecord,
} from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASIN_WRITE_REPOSITORY } from '../src/asin/asin-write.service';
import { AsinModule } from '../src/asin/asin.module';
import { queryAsin, queryGroup } from './helpers/asin-query-fixtures';
import { sessionApp } from './helpers/session-app';

const id = 'writer-85',
  sessionId = 'session-85';
const groupBody = {
  name: 'Fixture',
  country: 'US',
  site: 'amazon.com',
  brand: 'Fixture',
};
const asinBody = {
  asin: 'B000000083',
  name: 'Fixture',
  country: 'US',
  site: 'amazon.com',
  brand: 'Fixture',
  asinType: '1',
};
const routes = [
  {
    method: 'POST',
    path: '/variant-groups',
    body: groupBody,
    operation: 'createGroup',
    schema: variantGroupResultSchema,
  },
  {
    method: 'PUT',
    path: '/variant-groups/group-83',
    body: groupBody,
    operation: 'updateGroup',
    schema: variantGroupResultSchema,
  },
  {
    method: 'POST',
    path: '/asins',
    body: { ...asinBody, parentId: 'group-83' },
    operation: 'createAsin',
    schema: asinRecordResultSchema,
  },
  {
    method: 'PUT',
    path: '/asins/asin-83',
    body: asinBody,
    operation: 'updateAsin',
    schema: asinRecordResultSchema,
  },
  {
    method: 'POST',
    path: '/asins/asin-83/move',
    body: { targetGroupId: 'group-83' },
    operation: 'moveAsin',
    schema: asinRecordResultSchema,
  },
] as const;
const lifecycleRoutes = [
  {
    method: 'DELETE',
    path: '/variant-groups/group-83',
    operation: 'deleteGroup',
    permission: 'asin:delete',
  },
  {
    method: 'DELETE',
    path: '/asins/asin-83',
    operation: 'deleteAsin',
    permission: 'asin:delete',
  },
  {
    method: 'PUT',
    path: '/variant-groups/group-83/feishu-notify',
    operation: 'updateGroupNotify',
    permission: 'asin:write',
  },
  {
    method: 'PUT',
    path: '/asins/asin-83/feishu-notify',
    operation: 'updateAsinNotify',
    permission: 'asin:write',
  },
] as const;
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
  const permissions = ['asin:write'];
  const group = {
    groups: [queryGroup()],
    asins: [queryAsin()],
    total: 0,
    totalASINs: 0,
  };
  const snapshot = { group: queryGroup(), asin: queryAsin() };
  const unit = {
    lockOperator: vi.fn(async () => user),
    lockSession: vi.fn(async () => session),
    operatorPermissionCodes: vi.fn(async () => permissions),
    createGroup: vi.fn(async () => group),
    updateGroup: vi.fn(async () => group),
    createAsin: vi.fn(async () => snapshot),
    updateAsin: vi.fn(async () => snapshot),
    moveAsin: vi.fn(async () => snapshot),
    deleteGroup: vi.fn(async () => {}),
    deleteAsin: vi.fn(async () => {}),
    updateGroupNotify: vi.fn(async () => group),
    updateAsinNotify: vi.fn(async () => snapshot),
  } as unknown as AsinWriteUnit;
  const repository: AsinWriteRepositoryPort = {
    transaction: vi.fn(async (operation) => operation(unit)),
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
      { id: 'editor-85', code: 'EDITOR', name: 'Fixture' },
    ]),
    touchSession: vi.fn(),
    revokeSession: vi.fn(),
    markPasswordChangeRequired: vi.fn(),
    listSessionsByUserId: vi.fn(async () => []),
    revokeOwnedSession: vi.fn(async () => true),
  };
  return { user, session, permissions, unit, repository, auth };
}
describe('ASIN writes / HTTP current permission and commit boundaries', () => {
  let f: ReturnType<typeof data>,
    app: Awaited<ReturnType<typeof sessionApp>>,
    headers: { authorization: string };
  async function start(overrides: NodeJS.ProcessEnv = {}) {
    app = await sessionApp(
      f.auth,
      overrides,
      (builder) =>
        builder.overrideProvider(ASIN_WRITE_REPOSITORY).useValue(f.repository),
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
  const request = (
    route = routes[0] as (typeof routes)[number],
    auth: Record<string, string> = headers,
    payload: Record<string, unknown> = route.body,
  ) =>
    app.http.inject({
      method: route.method,
      url: `/api/v1${route.path}`,
      headers: auth,
      payload,
    });
  const lifecycleRequest = (
    route: (typeof lifecycleRoutes)[number],
    auth = headers as Record<string, string>,
    path = route.path as string,
    payload: Record<string, unknown> = { enabled: 0 },
  ) =>
    app.http.inject({
      method: route.method,
      url: `/api/v1${path}`,
      headers: auth,
      ...(route.method === 'PUT' ? { payload } : {}),
    });
  const grantLifecycle = (permission: 'asin:write' | 'asin:delete') => {
    f.auth.getPermissionCodes.mockResolvedValue([permission]);
    f.permissions.splice(0, f.permissions.length, permission);
  };
  it.each(lifecycleRoutes)('requires login for $operation', async (route) => {
    expect((await lifecycleRequest(route, {})).statusCode).toBe(401);
    expect(f.repository.transaction).not.toHaveBeenCalled();
  });
  it.each(lifecycleRoutes)(
    'accepts only the precise permission for $operation and returns its complete envelope',
    async (route) => {
      grantLifecycle(route.permission);
      const response = await lifecycleRequest(route, {
        ...headers,
        origin: app.env.CORS_ORIGIN,
      });
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const recordId = route.path.includes('variant-groups')
        ? 'group-83'
        : 'asin-83';
      if (route.method === 'DELETE') {
        expect(response.json()).toEqual({
          success: true,
          errorCode: 0,
          data: '删除成功',
        });
        expect(f.unit[route.operation]).toHaveBeenCalledWith(recordId);
      } else {
        (route.operation === 'updateGroupNotify'
          ? variantGroupResultSchema
          : asinRecordResultSchema
        ).parse(response.json());
        expect(f.unit[route.operation]).toHaveBeenCalledWith(recordId, false);
      }
    },
  );
  it.each(lifecycleRoutes)(
    'does not confuse write and delete permission for $operation',
    async (route) => {
      grantLifecycle(
        route.permission === 'asin:delete' ? 'asin:write' : 'asin:delete',
      );
      expect((await lifecycleRequest(route)).statusCode).toBe(403);
      expect(f.repository.transaction).not.toHaveBeenCalled();
    },
  );
  it.each(lifecycleRoutes)(
    'rejects current permission revocation despite a cached guard for $operation',
    async (route) => {
      grantLifecycle(route.permission);
      f.permissions.length = 0;
      expect((await lifecycleRequest(route)).statusCode).toBe(403);
      expect(f.unit[route.operation]).not.toHaveBeenCalled();
    },
  );
  it.each(lifecycleRoutes)(
    'rejects an unexpected Origin for $operation',
    async (route) => {
      grantLifecycle(route.permission);
      expect(
        (
          await lifecycleRequest(route, {
            ...headers,
            origin: 'https://unexpected.example',
          })
        ).statusCode,
      ).toBe(403);
      expect(f.unit[route.operation]).not.toHaveBeenCalled();
    },
  );
  it.each(lifecycleRoutes)(
    'rejects invalid identifiers before $operation',
    async (route) => {
      grantLifecycle(route.permission);
      expect(
        (
          await lifecycleRequest(
            route,
            headers,
            route.path.replace(/(?:group|asin)-83/, '%00'),
          )
        ).statusCode,
      ).toBe(400);
      expect(f.unit[route.operation]).not.toHaveBeenCalled();
    },
  );
  it.each(lifecycleRoutes.filter((route) => route.method === 'PUT'))(
    'rejects string flags without calling $operation',
    async (route) => {
      grantLifecycle(route.permission);
      expect(
        (await lifecycleRequest(route, headers, route.path, { enabled: '1' }))
          .statusCode,
      ).toBe(400);
      expect(f.unit[route.operation]).not.toHaveBeenCalled();
    },
  );
  it.each(lifecycleRoutes.filter((route) => route.method === 'DELETE'))(
    'does not return deletion success if the transaction fails for $operation',
    async (route) => {
      grantLifecycle(route.permission);
      vi.mocked(f.repository.transaction).mockImplementationOnce(
        async (action) => {
          await action(f.unit);
          throw new Error('private commit failure');
        },
      );
      const response = await lifecycleRequest(route);
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        success: false,
        errorMessage: '服务器内部错误',
      });
      expect(app.logger.info).not.toHaveBeenCalledWith(
        'ASIN 写入完成',
        'AsinWriteService',
        expect.any(Object),
      );
    },
  );
  it.each(routes)('requires login for $method $path', async (route) => {
    expect((await request(route, {})).statusCode).toBe(401);
    expect(f.repository.transaction).not.toHaveBeenCalled();
  });
  it.each(routes)(
    'allows asin:write and emits its contract only after the transaction for $operation',
    async (route) => {
      const response = await request(route, {
        ...headers,
        origin: app.env.CORS_ORIGIN,
      });
      expect(response.statusCode).toBe(200);
      route.schema.parse(response.json());
      expect(response.headers['cache-control']).toBe('no-store');
      expect(f.unit[route.operation]).toHaveBeenCalledOnce();
      expect(app.logger.info).toHaveBeenCalledWith(
        'ASIN 写入完成',
        'AsinWriteService',
        expect.any(Object),
      );
    },
  );
  it.each(routes)(
    'rejects an unexpected Origin on $operation',
    async (route) => {
      expect(
        (
          await request(route, {
            ...headers,
            origin: 'https://untrusted.example',
          })
        ).statusCode,
      ).toBe(403);
      expect(f.repository.transaction).not.toHaveBeenCalled();
    },
  );
  it.each(routes)(
    'honors current revoked permissions despite a cached guard result on $operation',
    async (route) => {
      f.permissions.splice(0);
      expect((await request(route)).statusCode).toBe(403);
      expect(f.unit[route.operation]).not.toHaveBeenCalled();
    },
  );
  it.each(routes)(
    'rejects incomplete input for $operation without invoking business writes',
    async (route) => {
      expect((await request(route, headers, {})).statusCode).toBe(400);
      expect(f.unit[route.operation]).not.toHaveBeenCalled();
    },
  );
  it.each(['user', 'password', 'password-expiry', 'session', 'session-expiry'])(
    'rechecks current %s in the transaction',
    async (field) => {
      if (field === 'user') f.user.status = 'DISABLED';
      if (field === 'password') f.user.forcePasswordChange = true;
      if (field === 'password-expiry') f.user.passwordExpiresAt = new Date(0);
      if (field === 'session') f.session.status = 'REVOKED';
      if (field === 'session-expiry') f.session.expiresAt = new Date(0);
      expect((await request()).statusCode).toBe(403);
      expect(f.unit.createGroup).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['asin-not-found', 404],
    ['group-not-found', 404],
    ['duplicate', 409],
    ['parent-changed', 409],
    ['capacity', 429],
  ] as const)(
    'maps %s to a fixed %i without driver details',
    async (code, status) => {
      vi.mocked(f.repository.transaction).mockRejectedValueOnce(
        new AsinWriteRepositoryError(code),
      );
      const response = await request();
      expect(response.statusCode).toBe(status);
      expect(response.json().success).toBe(false);
    },
  );
  it('does not treat read-only permission as write permission', async () => {
    f.auth.getPermissionCodes.mockResolvedValue(['asin:read']);
    expect((await request()).statusCode).toBe(403);
    expect(f.repository.transaction).not.toHaveBeenCalled();
  });
  it('returns a fixed 503 for missing timestamp policy without invoking a business write', async () => {
    vi.mocked(f.repository.transaction).mockRejectedValueOnce(
      new AsinTimestampPolicyError(),
    );
    const response = await request();
    expect(response.statusCode).toBe(503);
    // The shared exception filter masks every 5xx body, including 503.
    expect(response.json().errorMessage).toBe('服务器内部错误');
    expect(f.unit.createGroup).not.toHaveBeenCalled();
    expect(app.logger.warn).toHaveBeenCalledWith(
      'ASIN 时间策略不可用',
      'AsinWriteService',
      {
        reason: 'asin_timestamp_policy_required',
      },
    );
  });
  it('does not report success or log completion before actual transaction settlement', async () => {
    let release!: () => void,
      settled = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(f.repository.transaction).mockImplementation(
      async (operation) => {
        const result = await operation(f.unit);
        await gate;
        return result;
      },
    );
    const pending = request().then((response) => {
      settled = true;
      return response;
    });
    try {
      await vi.waitFor(() => expect(f.unit.createGroup).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
      expect(app.logger.info).not.toHaveBeenCalledWith(
        'ASIN 写入完成',
        'AsinWriteService',
        expect.any(Object),
      );
    } finally {
      release();
      await pending;
    }
    expect((await pending).statusCode).toBe(200);
  });
  it('returns failure when commit fails after the business operation, without leaking its error', async () => {
    vi.mocked(f.repository.transaction).mockImplementationOnce(
      async (operation) => {
        await operation(f.unit);
        throw new Error('postgresql://fixture-private/password');
      },
    );
    const response = await request();
    expect(response.statusCode).toBe(500);
    expect(response.json().errorMessage).toBe('服务器内部错误');
    expect(app.logger.info).not.toHaveBeenCalledWith(
      'ASIN 写入完成',
      'AsinWriteService',
      expect.any(Object),
    );
    expect(
      response.body + JSON.stringify(app.logger.error.mock.calls),
    ).not.toContain('fixture-private');
  });
  it('refuses a group result that exceeds the children bound', async () => {
    vi.mocked(f.unit.updateGroup).mockRejectedValueOnce(
      new AsinQueryRepositoryError('too-many-children'),
    );
    const response = await request(routes[1]);
    expect(response.statusCode).toBe(413);
    expect(response.json().data).toBeUndefined();
  });
  it('bounds eight active write transactions and restores admission after actual completion', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(f.repository.transaction).mockImplementation(
      async (operation) => {
        await gate;
        return operation(f.unit);
      },
    );
    const pending = Array.from({ length: 8 }, () => Promise.resolve(request()));
    try {
      await vi.waitFor(() =>
        expect(f.repository.transaction).toHaveBeenCalledTimes(8),
      );
      expect((await request()).statusCode).toBe(429);
    } finally {
      release();
      await Promise.allSettled(pending);
    }
    expect((await request()).statusCode).toBe(200);
  });
  it('keeps PostgreSQL authority mandatory', async () => {
    await app.app.close();
    f = data();
    await start({
      AUTH_DATA_AUTHORITY: 'legacy-mysql',
      DB_HOST: 'localhost',
      DB_USER: 'fixture',
      DB_PASSWORD: 'fixture',
      DB_NAME: 'fixture',
    });
    expect((await request()).statusCode).toBe(503);
    expect(f.repository.transaction).not.toHaveBeenCalled();
  });
});
