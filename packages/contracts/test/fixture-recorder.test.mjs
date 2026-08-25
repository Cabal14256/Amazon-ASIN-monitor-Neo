import { describe, expect, it } from 'vitest';

import {
  mergeApiUrl,
  readPositiveInteger,
  sanitizeFixture,
} from '../scripts/record-fixtures.mjs';

describe('golden fixture 录制工具', () => {
  it('合并 baseURL 时去尾斜杠并去重 /api 前缀', () => {
    expect(mergeApiUrl('http://localhost:3001/', '/api/v1/tasks')).toBe(
      'http://localhost:3001/api/v1/tasks',
    );
    expect(mergeApiUrl('https://example.test/api/', '/api/v1/tasks')).toBe(
      'https://example.test/api/v1/tasks',
    );
    expect(mergeApiUrl('https://example.test/api/v1', '/api/v1/tasks')).toBe(
      'https://example.test/api/v1/tasks',
    );
    expect(mergeApiUrl('https://example.test/api/api/v1', '/v1/tasks')).toBe(
      'https://example.test/api/v1/tasks',
    );
    expect(() =>
      mergeApiUrl('https://example.test', 'https://evil.test/tasks'),
    ).toThrow();
  });

  it('落盘前遮盖认证信息、Webhook、PII 与 SP-API 配置值', () => {
    const sanitized = sanitizeFixture({
      username: 'admin',
      real_name: '真实姓名',
      last_login_ip: '192.0.2.1',
      ipAddress: '192.0.2.2',
      userAgent: 'browser fingerprint',
      sessionId: 'session-secret',
      nested: { webhookUrl: 'https://example.test/hook' },
      configKey: 'SP_API_US_REFRESH_TOKEN',
      configValue: 'raw-token',
      displayValue: 'raw-token',
      request_data: JSON.stringify({
        password: 'raw-password',
        configKey: 'SP_API_US_REFRESH_TOKEN',
        configValue: 'serialized-token',
      }),
    });
    expect(sanitized).toMatchObject({
      username: '***MASKED***',
      real_name: '***MASKED***',
      last_login_ip: '***MASKED***',
      ipAddress: '***MASKED***',
      userAgent: '***MASKED***',
      sessionId: '***MASKED***',
      nested: { webhookUrl: '***MASKED***' },
      configKey: 'SP_API_US_REFRESH_TOKEN',
      configValue: '***MASKED***',
      displayValue: '***MASKED***',
    });
    expect(JSON.parse(sanitized.request_data)).toEqual({
      password: '***MASKED***',
      configKey: 'SP_API_US_REFRESH_TOKEN',
      configValue: '***MASKED***',
    });
    expect(sanitizeFixture({ request_data: 'not-json' })).toEqual({
      request_data: '***MASKED***',
    });
  });

  it('仅接受正整数请求超时', () => {
    expect(readPositiveInteger(undefined, 610_000)).toBe(610_000);
    expect(readPositiveInteger('30000', 610_000)).toBe(30_000);
    expect(() => readPositiveInteger('0', 610_000)).toThrow();
    expect(() => readPositiveInteger('1.5', 610_000)).toThrow();
  });
});
