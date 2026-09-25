import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../lib/http';
import { jsonResponse, sessionFixture } from '../lib/transport-fixtures';
import { auditLogId, getAuditLogDetail, getAuditLogs } from './audit-log';

const clients: HttpClient[] = [];
function setup() {
  const session = sessionFixture();
  const fetcher = vi.fn<typeof fetch>();
  const http = new HttpClient({
    baseURL: 'https://api.test/gateway/api/',
    pageOrigin: 'https://app.test',
    session: session.store,
    fetch: fetcher,
  });
  clients.push(http);
  return { http, fetcher };
}
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
});

const row = {
  id: 7,
  userId: 'user-1',
  username: 'alice',
  action: 'UPDATE',
  resource: 'asin',
  resourceId: 'asin-1',
  resourceName: 'B000000001',
  method: 'PUT',
  path: '/api/v1/asin/asin-1',
  ipAddress: '127.0.0.1',
  userAgent: 'fixture',
  requestData: { password: '***REDACTED***' },
  responseStatus: 200,
  errorMessage: null,
  createTime: '2026-09-24T01:30:00Z',
};

describe('audit log API boundary', () => {
  it('reads a filtered page with Shanghai wall time and normalized URL', async () => {
    const f = setup();
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { list: [row], total: 21, current: 2, pageSize: 10 },
      }),
    );
    const data = await getAuditLogs(f.http, {
      username: 'alice',
      action: 'UPDATE',
      startTime: '2026-09-24 09:30:00',
      current: 2,
      pageSize: 10,
    });
    expect(data.total).toBe(21);
    expect(data.list[0].username).toBe('alice');
    const url = String(f.fetcher.mock.calls[0][0]);
    expect(url).toContain('/gateway/api/v1/audit-logs?');
    expect(url).not.toContain('/api/api/');
    expect(new URL(url).searchParams.get('startTime')).toBe(
      '2026-09-24 09:30:00',
    );
    expect(new URL(url).searchParams.get('username')).toBe('alice');
    expect(f.fetcher.mock.calls[0][1]?.credentials).toBe('include');
  });

  it('validates detail identity and blocks invalid IDs before transport', async () => {
    const f = setup();
    f.fetcher.mockResolvedValueOnce(jsonResponse({ success: true, data: row }));
    expect((await getAuditLogDetail(f.http, 7)).id).toBe(7);
    expect(f.fetcher.mock.calls[0][0]).toBe(
      'https://api.test/gateway/api/v1/audit-logs/7',
    );
    f.fetcher.mockResolvedValueOnce(jsonResponse({ success: true, data: row }));
    await expect(getAuditLogDetail(f.http, 8)).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
    });
    expect(() => auditLogId(0)).toThrow();
    expect(() => auditLogId(Number.MAX_SAFE_INTEGER + 1)).toThrow();
    await expect(getAuditLogDetail(f.http, 0)).rejects.toMatchObject({
      kind: 'INVALID_INPUT',
    });
    expect(f.fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid filters, pagination and mismatched envelopes', async () => {
    const f = setup();
    await expect(
      getAuditLogs(f.http, { current: 1, pageSize: 101 }),
    ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
    await expect(
      getAuditLogs(f.http, {
        startTime: '2026-02-30 09:00:00',
        current: 1,
        pageSize: 10,
      }),
    ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
    expect(f.fetcher).not.toHaveBeenCalled();
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { list: [row], total: 1, current: 2, pageSize: 10 },
      }),
    );
    await expect(
      getAuditLogs(f.http, { current: 1, pageSize: 10 }),
    ).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
  });
});
