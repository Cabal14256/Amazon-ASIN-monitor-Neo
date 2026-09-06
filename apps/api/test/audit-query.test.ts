import { AuditQueryError } from '@asin-monitor/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { auditQueryApp } from './helpers/audit-query-app';

const routes = ['', '/19', '/statistics/actions', '/statistics/resources'];
describe('Neo audit query HTTP authorization and validation', () => {
  const queries = {
    list: vi.fn(),
    detail: vi.fn(),
    actions: vi.fn(),
    resources: vi.fn(),
  };
  let fixture: Awaited<ReturnType<typeof auditQueryApp>>;
  beforeEach(async () => {
    vi.resetAllMocks();
    queries.list.mockResolvedValue({
      list: [],
      total: 0,
      current: 1,
      pageSize: 10,
    });
    queries.detail.mockResolvedValue(null);
    queries.actions.mockResolvedValue([{ action: 'UPDATE', count: 2 }]);
    queries.resources.mockResolvedValue([{ resource: null, count: 1 }]);
    fixture = await auditQueryApp(queries);
  });
  afterEach(async () => {
    await fixture.app.close();
  });
  it.each(routes)(
    'requires a live session before querying %s',
    async (suffix) => {
      const response = await fixture.http.inject({
        method: 'GET',
        url: `/api/v1/audit-logs${suffix}`,
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ success: false, errorCode: 401 });
      for (const query of Object.values(queries))
        expect(query).not.toHaveBeenCalled();
    },
  );
  it.each(routes)('requires audit:read for %s', async (suffix) => {
    fixture.auth.getPermissionCodes.mockResolvedValue(['asin:read']);
    const response = await fixture.http.inject({
      method: 'GET',
      url: `/api/v1/audit-logs${suffix}`,
      headers: fixture.headers,
    });
    expect(response.statusCode).toBe(403);
    for (const query of Object.values(queries))
      expect(query).not.toHaveBeenCalled();
  });
  it('passes normalized time, typed pagination, and text filters to the repository', async () => {
    const response = await fixture.http.inject({
      method: 'GET',
      url: '/api/v1/audit-logs?current=2&pageSize=3&userId=fixture&username=Ab%25&action=UPDATE&resource=asin&resourceId=one&startTime=2026-09-01&endTime=2026-09-02T00%3A00%3A00%2B08%3A00',
      headers: fixture.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(queries.list).toHaveBeenCalledExactlyOnceWith({
      current: 2,
      pageSize: 3,
      userId: 'fixture',
      username: 'Ab%',
      action: 'UPDATE',
      resource: 'asin',
      resourceId: 'one',
      startTime: '2026-08-31T16:00:00.000Z',
      endTime: '2026-09-01T16:00:00.000Z',
    });
    expect(response.json()).toEqual({
      success: true,
      errorCode: 0,
      data: { list: [], total: 0, current: 1, pageSize: 10 },
    });
  });
  it.each([
    '/0',
    '/01',
    '/9007199254740992',
    '/abc',
    '?pageSize=101',
    '?current=1e2',
    '?current=1&current=2',
    '?startTime=2026-02-30',
    '?startTime=2026-09-02&endTime=2026-09-01',
    '?unknown=one',
    '/statistics/actions?current=1',
    '/statistics/resources?endTime=nope',
  ])('rejects malformed query or id %s before reading', async (suffix) => {
    const response = await fixture.http.inject({
      method: 'GET',
      url: `/api/v1/audit-logs${suffix}`,
      headers: fixture.headers,
    });
    expect(response.statusCode).toBe(400);
    for (const query of Object.values(queries))
      expect(query).not.toHaveBeenCalled();
  });
  it('returns 404 for a missing id and routes named statistics correctly', async () => {
    const missing = await fixture.http.inject({
      method: 'GET',
      url: '/api/v1/audit-logs/19',
      headers: fixture.headers,
    });
    expect(missing.statusCode).toBe(404);
    expect(queries.detail).toHaveBeenCalledExactlyOnceWith(19);
    for (const kind of ['actions', 'resources'] as const) {
      const response = await fixture.http.inject({
        method: 'GET',
        url: `/api/v1/audit-logs/statistics/${kind}?startTime=2026-09-01`,
        headers: fixture.headers,
      });
      expect(response.statusCode).toBe(200);
      expect(queries[kind]).toHaveBeenCalledExactlyOnceWith({
        startTime: '2026-08-31T16:00:00.000Z',
      });
      expect(response.json().data).toEqual(
        kind === 'actions'
          ? [{ action: 'UPDATE', count: 2 }]
          : [{ resource: null, count: 1 }],
      );
    }
  });
  it.each([
    [new AuditQueryError('capacity'), 503, 'warn'],
    [new AuditQueryError('timeout'), 504, 'warn'],
    [new AuditQueryError('invalid-result'), 500, 'error'],
    [new Error('SELECT fixture-secret FROM private-data'), 500, 'error'],
  ] as const)(
    'returns a sanitized failure for %s',
    async (error, status, level) => {
      queries.list.mockRejectedValue(error);
      const response = await fixture.http.inject({
        method: 'GET',
        url: '/api/v1/audit-logs?username=fixture-person',
        headers: fixture.headers,
      });
      expect(response.statusCode).toBe(status);
      expect(response.json()).toMatchObject({
        success: false,
        errorCode: status,
        errorMessage: '服务器内部错误',
      });
      expect(fixture.logger[level]).toHaveBeenCalled();
      const outputs = JSON.stringify([
        response.json(),
        ...Object.values(fixture.logger).map((log) => log.mock.calls),
      ]);
      expect(outputs).not.toContain('fixture-secret');
      expect(outputs).not.toContain('fixture-person');
    },
  );
});
