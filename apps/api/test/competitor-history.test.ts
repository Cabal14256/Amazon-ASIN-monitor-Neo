import {
  competitorMonitorHistoryDetailResultSchema,
  competitorMonitorHistoryListResultSchema,
} from '@asin-monitor/contracts';
import {
  MonitorHistoryQueryError,
  type AuthSessionRecord,
  type AuthUserRecord,
  type CompetitorHistoryQueryRepositoryPort,
  type CompetitorHistoryQueryUnit,
} from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPETITOR_HISTORY_REPOSITORY } from '../src/competitor/competitor-history.service';
import { CompetitorModule } from '../src/competitor/competitor.module';
import { sessionApp } from './helpers/session-app';

const userId = 'operator-131',
  sessionId = 'session-131';
function fixture() {
  const user: AuthUserRecord = {
    id: userId,
    username: userId,
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
    userId,
    userAgent: null,
    ipAddress: null,
    status: 'ACTIVE',
    rememberMe: false,
    createdAt: new Date(),
    lastActiveAt: new Date(),
    expiresAt: new Date('2099-01-01T00:00:00Z'),
  };
  const permissions = ['monitor:read'];
  const record = {
    id: 131,
    variant_group_id: 'g131',
    asin_id: 'a131',
    country: 'US',
    check_type: 'ASIN',
    checkType: 'ASIN',
    check_time: '2026-09-12T16:30:12.000Z',
    checkTime: '2026-09-12T16:30:12.000Z',
    check_result: '{"parentAsin":"B000000001"}',
    parentAsin: 'B000000001',
    create_time: null,
    createTime: null,
  };
  const unit: CompetitorHistoryQueryUnit = {
    lockOperator: vi.fn(async () => user),
    lockSession: vi.fn(async () => session),
    operatorPermissionCodes: vi.fn(async () => permissions),
    listHistory: vi.fn(async () => ({ list: [record], total: 1 })),
    historyById: vi.fn(async () => record),
  };
  const repository: CompetitorHistoryQueryRepositoryPort = {
    read: vi.fn(async (action) => action(unit)),
    close: vi.fn(),
  };
  const auth = {
    findUserById: vi.fn(async () => structuredClone(user)),
    findSessionById: vi.fn(async () => structuredClone(session)),
    getPermissionCodes: vi.fn(async () => ['monitor:read']),
    getRoles: vi.fn(async () => [
      { id: 'reader-131', code: 'READONLY', name: 'Fixture' },
    ]),
    touchSession: vi.fn(),
    revokeSession: vi.fn(),
    markPasswordChangeRequired: vi.fn(),
    listSessionsByUserId: vi.fn(async () => []),
    revokeOwnedSession: vi.fn(async () => true),
  };
  return { user, session, permissions, record, unit, repository, auth };
}

describe('competitor history HTTP / current primary authorization', () => {
  let f: ReturnType<typeof fixture>;
  let app: Awaited<ReturnType<typeof sessionApp>>;
  let headers: { authorization: string };
  const paths = [
    '/competitor/monitor-history',
    '/competitor/monitor-history/131',
  ];
  beforeEach(async () => {
    f = fixture();
    app = await sessionApp(
      f.auth,
      {},
      (builder) =>
        builder
          .overrideProvider(COMPETITOR_HISTORY_REPOSITORY)
          .useValue(f.repository),
      [CompetitorModule],
    );
    headers = {
      authorization: `Bearer ${jwt.sign(
        { userId, sessionId },
        app.env.JWT_SECRET,
        { expiresIn: '1h' },
      )}`,
    };
  });
  afterEach(async () => {
    await app.app.close();
    vi.restoreAllMocks();
  });
  const get = (
    app: Awaited<ReturnType<typeof sessionApp>>,
    path: string,
    headers: Record<string, string>,
  ) => app.http.inject({ method: 'GET', url: `/api/v1${path}`, headers });
  it.each(paths)('requires login before business reads on %s', async (path) => {
    expect((await get(app, path, {})).statusCode).toBe(401);
    expect(f.repository.read).not.toHaveBeenCalled();
  });
  it.each(paths)(
    'returns complete records and no-store on %s',
    async (path) => {
      const response = await get(app, path, headers);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      (path === paths[0]
        ? competitorMonitorHistoryListResultSchema
        : competitorMonitorHistoryDetailResultSchema
      ).parse(response.json());
      expect(response.json().data).toMatchObject(
        path === paths[0]
          ? { list: [f.record], total: 1, current: 1, pageSize: 10 }
          : f.record,
      );
    },
  );
  it('preserves competitor-specific LIKE and false filters', async () => {
    const response = await get(
      app,
      `${paths[0]}?asin=B000%25_1&isBroken=other&current=2&pageSize=50`,
      headers,
    );
    expect(response.statusCode).toBe(200);
    expect(f.unit.listHistory).toHaveBeenCalledWith({
      asin: 'B000%_1',
      isBroken: false,
      current: 2,
      pageSize: 50,
    });
  });
  it.each(['?pageSize=101', '?country=US&country=UK', '?startTime=invalid'])(
    'rejects invalid filters before the competitor database on %s',
    async (suffix) => {
      expect((await get(app, paths[0] + suffix, headers)).statusCode).toBe(400);
      expect(f.unit.listHistory).not.toHaveBeenCalled();
    },
  );
  it('rejects revocation after the guard before competitor access', async () => {
    f.permissions.splice(0);
    expect((await get(app, paths[0], headers)).statusCode).toBe(403);
    expect(f.unit.listHistory).not.toHaveBeenCalled();
  });
  it('returns the Legacy missing-history message', async () => {
    vi.mocked(f.unit.historyById).mockResolvedValue(null);
    const response = await get(app, paths[1], headers);
    expect(response.statusCode).toBe(404);
    expect(response.json().errorMessage).toBe('竞品监控历史不存在');
  });
  it('maps capacity and oversized results without leaking driver values', async () => {
    vi.mocked(f.repository.read).mockRejectedValue(
      new MonitorHistoryQueryError('too-large'),
    );
    expect((await get(app, paths[0], headers)).statusCode).toBe(413);
    vi.mocked(f.repository.read).mockRejectedValue(
      new Error('password=private131'),
    );
    const response = await get(app, paths[0], headers);
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('private131');
  });
});
