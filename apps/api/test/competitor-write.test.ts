import {
  competitorAsinRecordResultSchema,
  competitorBatchCreateResultSchema,
  competitorDeleteGroupResultSchema,
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
  {
    method: 'DELETE',
    url: '/competitor/variant-groups/group-119',
    body: { expectedChildIds: ['asin-119'] },
    action: 'deleteGroup',
  },
  {
    method: 'DELETE',
    url: '/competitor/asins/asin-119',
    body: undefined,
    action: 'deleteAsin',
  },
  {
    method: 'PUT',
    url: '/competitor/variant-groups/group-119/feishu-notify',
    body: { enabled: true },
    action: 'updateGroupNotify',
  },
  {
    method: 'PUT',
    url: '/competitor/asins/asin-119/feishu-notify',
    body: { enabled: true },
    action: 'updateAsinNotify',
  },
  {
    method: 'POST',
    url: '/competitor/asins/batch-create',
    body: { items: [{ ...asinBody, parentId: 'group-119' }] },
    action: 'batchCreateAsins',
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
    batchCreateAsins: vi.fn(async () => ({
      total: 1,
      successCount: 1,
      failedCount: 0,
      errors: [],
      results: [
        {
          index: 0,
          id: 'asin-125',
          asin: 'B000000121',
          country: 'US',
          parentId: 'group-119',
          success: true,
        },
      ],
    })),
    updateAsin: vi.fn(async () => competitorQueryAsin()),
    moveAsin: vi.fn(async () => competitorQueryAsin()),
    deleteGroup: vi.fn(async () => {}),
    deleteAsin: vi.fn(async () => {}),
    updateGroupNotify: vi.fn(async () => result),
    updateAsinNotify: vi.fn(async () => competitorQueryAsin()),
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
      (value.method === 'DELETE'
        ? competitorDeleteGroupResultSchema
        : value.action === 'batchCreateAsins'
        ? competitorBatchCreateResultSchema
        : value.action.includes('Group')
        ? competitorGroupResultSchema
        : competitorAsinRecordResultSchema
      ).parse(result.json());
      if (value.method === 'DELETE')
        expect(result.json()).toEqual({
          success: true,
          errorCode: 0,
          data: '删除成功',
        });
      else expect(result.json().data).not.toHaveProperty('site');
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
  it.each([cases[5], cases[6]])(
    'retains Legacy asin:write without asin:delete for $action',
    async (value) => {
      f.auth.getPermissionCodes.mockResolvedValue(['asin:write']);
      f.permissions.splice(0, f.permissions.length, 'asin:write');
      expect((await request(value)).statusCode).toBe(200);
      expect(f.unit[value.action]).toHaveBeenCalledOnce();
    },
  );
  it.each([cases[5], cases[6]])(
    'rejects asin:delete without Legacy asin:write before $action starts',
    async (value) => {
      f.auth.getPermissionCodes.mockResolvedValue(['asin:delete']);
      expect((await request(value)).statusCode).toBe(403);
      expect(f.repository.transaction).not.toHaveBeenCalled();
    },
  );
  it.each([cases[5], cases[6]])(
    'rechecks Legacy asin:write inside the transaction for $action',
    async (value) => {
      f.permissions.splice(0, f.permissions.length, 'asin:delete');
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
    expect(f.unit.createAsin).toHaveBeenCalledWith(
      {
        asin: 'B000000121',
        country: 'US',
        brand: 'Own brand',
        asinType: '2',
        name: null,
        parentId: 'group-119',
      },
      undefined,
    );
    expect(f.unit.moveAsin).toHaveBeenCalledWith(
      'asin-119',
      'group-target',
      undefined,
    );
  });
  it('forwards the original move parent and reports a locked source conflict', async () => {
    const body = {
      targetGroupId: 'group-target',
      expectedSourceGroup: 'group-119',
    };
    expect((await request(cases[4], headers, body)).statusCode).toBe(200);
    expect(f.unit.moveAsin).toHaveBeenCalledWith(
      'asin-119',
      'group-target',
      'group-119',
    );
    vi.mocked(f.unit.moveAsin).mockRejectedValueOnce(
      new CompetitorWriteError('source-changed'),
    );
    expect((await request(cases[4], headers, body)).statusCode).toBe(409);
    for (const expectedSourceGroup of ['', null, [], 'g'.repeat(51)]) {
      expect(
        (await request(cases[4], headers, { ...body, expectedSourceGroup }))
          .statusCode,
      ).toBe(400);
    }
    expect(f.unit.moveAsin).toHaveBeenCalledTimes(2);
  });
  it('forwards optional parent snapshots separately from new ASIN fields and sanitizes locked conflicts', async () => {
    const expectedParent = {
      name: 'Original parent',
      country: 'US',
      brand: 'Original brand',
      updateTime: '2020-01-01T00:00:00.000Z',
    };
    const body = { ...cases[2].body, expectedParent };
    expect((await request(cases[2], headers, body)).statusCode).toBe(200);
    expect(f.unit.createAsin).toHaveBeenCalledWith(
      {
        asin: 'B000000121',
        country: 'US',
        brand: 'Own brand',
        asinType: '2',
        name: null,
        parentId: 'group-119',
      },
      expectedParent,
    );
    vi.mocked(f.unit.createAsin).mockRejectedValueOnce(
      new CompetitorWriteError('source-changed'),
    );
    const conflict = await request(cases[2], headers, body);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().errorMessage).toBe('竞品记录已变化，请刷新后重试');
    expect(conflict.body).not.toContain(expectedParent.name);
    f.permissions.splice(0);
    expect((await request(cases[2], headers, body)).statusCode).toBe(403);
    expect(f.unit.createAsin).toHaveBeenCalledTimes(2);
  });
  it.each(['', ' ', '\n\t\r'])(
    'allows repairing and deleting Legacy persisted group text %j',
    async (oldText) => {
      const expectedSource = {
        name: oldText,
        country: oldText,
        brand: oldText,
        updateTime: null,
      };
      expect(
        (await request(cases[1], headers, { ...groupBody, expectedSource }))
          .statusCode,
      ).toBe(200);
      expect(f.unit.updateGroup).toHaveBeenCalledWith(
        'group-119',
        { name: 'Group', country: 'US', brand: 'Brand' },
        expectedSource,
      );
      expect(
        (
          await request(cases[5], headers, {
            expectedSource,
            expectedChildIds: [],
          })
        ).statusCode,
      ).toBe(200);
      expect(f.unit.deleteGroup).toHaveBeenCalledWith(
        'group-119',
        [],
        expectedSource,
      );
    },
  );
  it('passes source snapshots into locked writes and returns a conflict when they change', async () => {
    const expectedGroup = {
      name: 'Previous group',
      country: 'US',
      brand: 'Previous brand',
      updateTime: '2020-01-01T00:00:00.000Z',
    };
    const expectedAsin = {
      variantGroupId: 'group-119',
      asin: 'B000000121',
      name: null,
      country: 'US',
      brand: 'Own brand',
      asinType: '2',
      updateTime: '2020-01-01T00:00:00.000Z',
    };
    expect(
      (
        await request(cases[1], headers, {
          ...groupBody,
          expectedSource: expectedGroup,
        })
      ).statusCode,
    ).toBe(200);
    expect(f.unit.updateGroup).toHaveBeenCalledWith(
      'group-119',
      { name: 'Group', country: 'US', brand: 'Brand' },
      expectedGroup,
    );
    expect(
      (
        await request(cases[3], headers, {
          ...asinBody,
          expectedSource: expectedAsin,
        })
      ).statusCode,
    ).toBe(200);
    expect(f.unit.updateAsin).toHaveBeenCalledWith(
      'asin-119',
      expect.anything(),
      expectedAsin,
    );
    expect(
      (await request(cases[6], headers, { expectedSource: expectedAsin }))
        .statusCode,
    ).toBe(200);
    expect(f.unit.deleteAsin).toHaveBeenCalledWith('asin-119', expectedAsin);
    vi.mocked(f.unit.deleteAsin).mockRejectedValueOnce(
      new CompetitorWriteError('source-changed'),
    );
    const conflict = await request(cases[6], headers, {
      expectedSource: expectedAsin,
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().errorMessage).toContain('已变化');
  });
  it('preserves bodyless Legacy deletes and validates optional Neo child snapshots', async () => {
    expect(
      (
        await app.http.inject({
          method: 'DELETE',
          url: '/api/v1/competitor/variant-groups/group-119',
          headers,
        })
      ).statusCode,
    ).toBe(200);
    expect(f.unit.deleteGroup).toHaveBeenCalledWith(
      'group-119',
      undefined,
      undefined,
    );
    expect((await request(cases[5], headers, {})).statusCode).toBe(200);
    vi.mocked(f.unit.deleteGroup).mockClear();
    for (const body of [
      { expectedChildIds: null },
      { expectedChildIds: 'asin-119' },
      { expectedChildIds: ['asin-119', 'asin-119'] },
      { expectedChildIds: [''] },
    ]) {
      expect((await request(cases[5], headers, body)).statusCode).toBe(400);
    }
    expect(f.unit.deleteGroup).not.toHaveBeenCalled();
    expect((await request(cases[5])).statusCode).toBe(200);
    expect(f.unit.deleteGroup).toHaveBeenCalledWith(
      'group-119',
      ['asin-119'],
      undefined,
    );
    expect(
      (await request(cases[5], headers, { expectedChildIds: [] })).statusCode,
    ).toBe(200);
    expect(f.unit.deleteGroup).toHaveBeenCalledWith('group-119', [], undefined);
  });
  it('forwards the confirmed group source and members to locked deletion and reports source conflicts', async () => {
    const expectedSource = {
      name: 'Confirmed group',
      country: 'US',
      brand: 'Confirmed brand',
      updateTime: '2020-01-01T00:00:00.000Z',
    };
    const body = { expectedChildIds: ['asin-119'], expectedSource };
    expect((await request(cases[5], headers, body)).statusCode).toBe(200);
    expect(f.unit.deleteGroup).toHaveBeenCalledWith(
      'group-119',
      ['asin-119'],
      expectedSource,
    );
    vi.mocked(f.unit.deleteGroup).mockRejectedValueOnce(
      new CompetitorWriteError('source-changed'),
    );
    const conflict = await request(cases[5], headers, body);
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().errorMessage).toBe('竞品记录已变化，请刷新后重试');
    expect(conflict.body).not.toContain(expectedSource.name);
    for (const invalid of [
      null,
      {},
      { ...expectedSource, name: '\u0000' },
      { ...expectedSource, country: 'x'.repeat(11) },
    ]) {
      expect(
        (await request(cases[5], headers, { ...body, expectedSource: invalid }))
          .statusCode,
      ).toBe(400);
    }
    expect(f.unit.deleteGroup).toHaveBeenCalledTimes(2);
  });
  it('reports changed group membership as a conflict without exposing child IDs', async () => {
    vi.mocked(f.unit.deleteGroup).mockRejectedValue(
      new CompetitorWriteError('members-changed'),
    );
    const response = await request(cases[5]);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      success: false,
      errorCode: 409,
      errorMessage: '竞品组成员已变化，请刷新后重新确认删除',
    });
    expect(response.body).not.toContain('asin-119');
  });
  it.each(cases.filter((value) => value.method !== 'DELETE'))(
    'rejects invalid bodies without writes on $action',
    async (value) => {
      expect(
        (await request(value, headers, { privateField: 'invalid' })).statusCode,
      ).toBe(400);
      expect(f.unit[value.action]).not.toHaveBeenCalled();
    },
  );
  it.each(cases.slice(5, 9))(
    'rejects an invalid decoded ID before $action',
    async (value) => {
      const response = await app.http.inject({
        method: value.method,
        url: `/api/v1${value.url.replace(/(?:group|asin)-119/, '%20')}`,
        headers,
        payload: value.body,
      });
      expect(response.statusCode).toBe(400);
      expect(f.unit[value.action]).not.toHaveBeenCalled();
    },
  );
  it.each([true, false, 0, 1])(
    'normalizes notification input %s on both actual routes',
    async (enabled) => {
      for (const value of cases.slice(7, 9)) {
        expect((await request(value, headers, { enabled })).statusCode).toBe(
          200,
        );
        expect(f.unit[value.action]).toHaveBeenCalledWith(
          value.url.includes('variant-groups') ? 'group-119' : 'asin-119',
          enabled === true || enabled === 1,
        );
      }
    },
  );
  it.each([undefined, null, '', 'true', 'false', '0', '1', 2, [], {}])(
    'rejects non-boolean notification input %j on both routes',
    async (enabled) => {
      for (const value of cases.slice(7, 9)) {
        expect((await request(value, headers, { enabled })).statusCode).toBe(
          400,
        );
        expect(f.unit[value.action]).not.toHaveBeenCalled();
      }
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
  it.each([{}, { items: [] }, { items: null }, { items: 'bad' }])(
    'preserves the empty batch error %#',
    async (body) => {
      const result = await request(cases[9], headers, body);
      expect(result.statusCode).toBe(400);
      expect(result.json().errorMessage).toBe('items不能为空');
      expect(f.unit.batchCreateAsins).not.toHaveBeenCalled();
    },
  );
  it('keeps invalid rows intact for individual results', async () => {
    const body = { items: [null] };
    expect((await request(cases[9], headers, body)).statusCode).toBe(200);
    expect(f.unit.batchCreateAsins).toHaveBeenCalledWith([null]);
  });
  it.each([
    { total: 2 },
    { successCount: 2 },
    { results: [] },
    { failedCount: 1 },
    { errors: [{ index: 0, asin: null, country: null, message: 'invalid' }] },
  ])(
    'rejects inconsistent batch responses before committing %#',
    async (changes) => {
      const valid = await f.unit.batchCreateAsins([]);
      vi.mocked(f.unit.batchCreateAsins).mockResolvedValue({
        ...valid,
        ...changes,
      });
      const result = await request(cases[9]);
      expect(result.statusCode).toBe(500);
      expect(result.json().data).toBeUndefined();
    },
  );
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
