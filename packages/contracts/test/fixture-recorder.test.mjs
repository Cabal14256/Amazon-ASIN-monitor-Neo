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
  });

  it('落盘前遮盖认证信息、Webhook、PII 与 SP-API 配置值', () => {
    expect(
      sanitizeFixture({
        username: 'admin',
        nested: { webhookUrl: 'https://example.test/hook' },
        configKey: 'SP_API_US_REFRESH_TOKEN',
        configValue: 'raw-token',
        displayValue: 'raw-token',
      }),
    ).toEqual({
      username: '***MASKED***',
      nested: { webhookUrl: '***MASKED***' },
      configKey: 'SP_API_US_REFRESH_TOKEN',
      configValue: '***MASKED***',
      displayValue: '***MASKED***',
    });
  });

  it('仅接受正整数请求超时', () => {
    expect(readPositiveInteger(undefined, 610_000)).toBe(610_000);
    expect(readPositiveInteger('30000', 610_000)).toBe(30_000);
    expect(() => readPositiveInteger('0', 610_000)).toThrow();
    expect(() => readPositiveInteger('1.5', 610_000)).toThrow();
  });
});
