import {
  MonitorAnalyticsQueryError,
  type HomeWorkbenchQueryRepositoryPort,
  type HomeWorkbenchQueryUnit,
} from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { homeWorkbenchFixture } from '../../../packages/contracts/test/helpers/home-workbench';
import { HomeWorkbenchModule } from '../src/home-workbench/home-workbench.module';
import { HOME_WORKBENCH_REPOSITORY } from '../src/home-workbench/home-workbench.service';
import { monitorAnalyticsFixture } from './helpers/monitor-analytics-fixture';
import { sessionApp } from './helpers/session-app';

describe('Neo Home workbench actual HTTP/current authorization boundaries', () => {
  let f: ReturnType<typeof monitorAnalyticsFixture>,
    app: Awaited<ReturnType<typeof sessionApp>>,
    unit: HomeWorkbenchQueryUnit,
    repository: HomeWorkbenchQueryRepositoryPort,
    headers: { authorization: string };
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T16:05:06.123Z'));
    f = monitorAnalyticsFixture();
    f.auth.getPermissionCodes.mockResolvedValue(['asin:read', 'monitor:read']);
    vi.mocked(f.unit.operatorPermissionCodes).mockResolvedValue([
      'asin:read',
      'monitor:read',
    ]);
    unit = {
      lockOperator: f.unit.lockOperator,
      lockSession: f.unit.lockSession,
      operatorPermissionCodes: f.unit.operatorPermissionCodes,
      workbench: vi.fn(async (query, _now, grant) => ({
        ...homeWorkbenchFixture(grant),
        current: query.current,
        pageSize: query.pageSize,
        facetCurrent: query.facetCurrent,
      })),
    };
    repository = { read: vi.fn(async (action) => action(unit)) };
    app = await sessionApp(
      f.auth,
      {},
      (builder) =>
        builder
          .overrideProvider(HOME_WORKBENCH_REPOSITORY)
          .useValue(repository),
      [HomeWorkbenchModule],
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
    if (app) await app.app.close();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  const get = (query = '', auth: Record<string, string> = headers) =>
    app.http.inject({
      method: 'GET',
      url: `/api/v1/dashboard/workbench${query}`,
      headers: auth,
    });
  it('returns real typed data and strict GET filters without changing original IDs', async () => {
    const response = await get(
      '?country=US&site=%20amazon.com%20&brand=%20Raw%20Brand%20&facetCurrent=2',
    );
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json().data.list[0].id).toBe(' Raw Ś ');
    expect(unit.workbench).toHaveBeenCalledWith(
      expect.objectContaining({
        country: 'US',
        site: ' amazon.com ',
        brand: ' Raw Brand ',
        facetCurrent: 2,
      }),
      expect.any(Date),
      true,
    );
  });
  it('requires authentication before repository reads', async () => {
    expect((await get('', {})).statusCode).toBe(401);
    expect(repository.read).not.toHaveBeenCalled();
  });
  it('passes an explicit empty brand to the exact database filter without treating it as absent', async () => {
    const response = await get('?brand=');
    expect(response.statusCode).toBe(200);
    expect(unit.workbench).toHaveBeenCalledWith(
      expect.objectContaining({ brand: '' }),
      expect.any(Date),
      true,
    );
  });
  it('denies a stale cached ASIN grant under the current transaction authorization', async () => {
    vi.mocked(unit.operatorPermissionCodes).mockResolvedValue(['monitor:read']);
    expect((await get()).statusCode).toBe(403);
    expect(unit.workbench).not.toHaveBeenCalled();
  });
  it.each([
    { codes: ['asin:read'] },
    { codes: ['asin:read', 'analytics:read'] },
  ])(
    'checks the actual historical grant %j before selecting SQL shape',
    async ({ codes }) => {
      vi.mocked(unit.operatorPermissionCodes).mockResolvedValue([...codes]);
      const response = await get();
      expect(response.statusCode).toBe(200);
      expect(response.json().data.trendsAuthorized).toBe(codes.length > 1);
      expect(response.json().data.list[0].trend === null).toBe(
        codes.length === 1,
      );
      expect(unit.workbench).toHaveBeenLastCalledWith(
        expect.any(Object),
        expect.any(Date),
        codes.length > 1,
      );
    },
  );
  it.each(['revoked', 'password', 'expired'] as const)(
    'rejects a current %s session/account before catalog/history reads',
    async (kind) => {
      if (kind === 'revoked')
        vi.mocked(unit.lockSession).mockResolvedValue({
          ...f.session,
          status: 'REVOKED',
        });
      if (kind === 'password')
        vi.mocked(unit.lockOperator).mockResolvedValue({
          ...f.user,
          forcePasswordChange: true,
        });
      if (kind === 'expired')
        vi.mocked(unit.lockSession).mockResolvedValue({
          ...f.session,
          expiresAt: new Date('2020-01-01'),
        });
      expect((await get()).statusCode).toBe(403);
      expect(unit.workbench).not.toHaveBeenCalled();
    },
  );
  it.each([
    '?pageSize=21',
    '?current=1001',
    '?facetCurrent=52',
    '?site=a&site=b',
    '?unexpected=true',
  ])('rejects bounded query violation %s', async (query) => {
    expect((await get(query)).statusCode).toBe(400);
    expect(unit.workbench).not.toHaveBeenCalled();
  });
  it('maps the native PostgreSQL deadline and holds no partial successful response', async () => {
    vi.mocked(unit.workbench).mockRejectedValue({ code: '57014' });
    const response = await get();
    expect(response.statusCode).toBe(504);
    expect(response.json()).not.toHaveProperty('data');
    expect(app.logger.warn).toHaveBeenCalledWith(
      '首页工作台查询超时',
      'HomeWorkbenchService',
      { reason: 'home_workbench_timeout' },
    );
  });
  it('rejects stale or incoherent authorization-shaped data before returning it', async () => {
    vi.mocked(unit.operatorPermissionCodes).mockResolvedValue(['asin:read']);
    vi.mocked(unit.workbench).mockResolvedValue(homeWorkbenchFixture(true));
    expect((await get()).statusCode).toBe(500);
  });
  it('keeps a hard serialized response cap even when a repository port violates the contract', async () => {
    const data = homeWorkbenchFixture();
    data.list[0].name = 'x'.repeat(512 * 1024);
    vi.mocked(unit.workbench).mockResolvedValue(data);
    expect((await get()).statusCode).toBe(413);
  });
  it('maps bounded pool capacity rather than retrying the database operation', async () => {
    vi.mocked(repository.read).mockRejectedValue(
      new MonitorAnalyticsQueryError('capacity'),
    );
    expect((await get()).statusCode).toBe(429);
    expect(repository.read).toHaveBeenCalledOnce();
  });
});
