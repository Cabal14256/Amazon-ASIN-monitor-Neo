import { feishuConfigListResultSchema } from '@asin-monitor/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  displayFeishuConfiguration,
  feishuConfigurationChange,
  FeishuConfigurationError,
  feishuCountry,
  feishuEnabled,
  feishuRegion,
  validateFeishuRow,
} from '../src/domain/feishu-configuration';
import { feishuConfigurationLegacy } from './helpers/feishu-configuration-legacy';

const fixture = (enabled: boolean | null = true) => ({
  id: 7,
  country: 'EU',
  webhookUrl: 'https://example.invalid/fixture-webhook',
  enabled,
  createTime: new Date('2026-09-13T00:00:00Z'),
  updateTime: null,
});
const raw = (enabled: boolean | null) => ({
  id: 7,
  country: 'EU',
  webhook_url: fixture().webhookUrl,
  enabled: enabled === null ? null : enabled ? 1 : 0,
  create_time: fixture().createTime,
  update_time: null,
});
describe('Feishu configuration / actual Legacy result and input rules', () => {
  it.each([true, false, null])(
    'preserves every list field, nullable time and enabled=%s',
    async (enabled) => {
      const query = vi.fn(async (_sql: string, _params?: unknown[]) => [
        raw(enabled),
      ]);
      const expected = await feishuConfigurationLegacy(query)(
        'getFeishuConfigs',
      );
      expect(feishuConfigListResultSchema.parse(expected.body)).toEqual(
        expected.body,
      );
      expect(expected).toEqual({
        statusCode: 200,
        body: {
          success: true,
          errorCode: 0,
          data: [displayFeishuConfiguration(fixture(enabled), 'camel', true)],
        },
      });
      expect(query.mock.calls[0][0]).toContain("country IN ('US', 'EU')");
    },
  );
  it.each(['US', 'UK', 'DE', 'FR', 'IT', 'ES', 'EU', 'uk', 'UK ', 'JP'])(
    'preserves the exact country-to-region mapping for %s',
    async (country) => {
      const query = vi.fn(async (_sql: string, _params?: unknown[]) => [
        raw(true),
      ]);
      const expected = await feishuConfigurationLegacy(query)(
        'getFeishuConfigByCountry',
        {},
        country,
      );
      expect(query.mock.calls[0][1]).toEqual([feishuRegion(country)]);
      expect(expected).toEqual({
        statusCode: 200,
        body: {
          success: true,
          errorCode: 0,
          data: displayFeishuConfiguration(fixture(), 'snake', true),
        },
      });
    },
  );
  it('uses body.country even when PUT path country differs and keeps a disabled upsert response', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => [
      raw(false),
    ]);
    const body = {
      country: 'EU',
      webhookUrl: fixture().webhookUrl,
      enabled: false,
    };
    const expected = await feishuConfigurationLegacy(query)(
      'upsertFeishuConfig',
      body,
      'US',
    );
    expect(query.mock.calls[0][1]).toEqual(['EU']);
    expect(query.mock.calls[1][1]).toEqual([body.webhookUrl, 0, 'EU']);
    expect(feishuConfigurationChange(body)).toEqual(body);
    expect(expected).toEqual({
      statusCode: 200,
      body: {
        success: true,
        errorCode: 0,
        data: displayFeishuConfiguration(fixture(false), 'camel', true),
      },
    });
  });
  it('keeps the update-before-404 behavior when disabling a configuration', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => []);
    const result = await feishuConfigurationLegacy(query)(
      'toggleFeishuConfig',
      { enabled: false },
      'UK',
    );
    expect(query.mock.calls[0][0]).toContain(
      'UPDATE feishu_config SET enabled',
    );
    expect(query.mock.calls[0][1]).toEqual([0, 'UK']);
    expect(query.mock.calls[1][1]).toEqual(['EU']);
    expect(result).toEqual({
      statusCode: 404,
      body: { success: false, errorMessage: '配置不存在', errorCode: 404 },
    });
  });
  it('keeps deletion idempotent and uses the unmodified country', async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => []);
    const result = await feishuConfigurationLegacy(query)(
      'deleteFeishuConfig',
      {},
      'UK',
    );
    expect(query.mock.calls[0][1]).toEqual(['UK']);
    expect(result).toEqual({
      statusCode: 200,
      body: { success: true, errorCode: 0, data: '删除成功' },
    });
  });
  it('accepts all contract booleans, defaults enabled, and preserves input whitespace', () => {
    for (const enabled of [0, 1, false, true]) {
      expect(
        feishuConfigurationChange({
          country: 'US ',
          webhookUrl: ' URL ',
          enabled,
        }),
      ).toEqual({
        country: 'US ',
        webhookUrl: ' URL ',
        enabled: Boolean(enabled),
      });
      expect(feishuEnabled({ enabled })).toBe(Boolean(enabled));
    }
    expect(
      feishuConfigurationChange({ country: 'EU', webhookUrl: 'x' }).enabled,
    ).toBe(true);
    expect(feishuCountry('😀'.repeat(10))).toBe('😀'.repeat(10));
  });
  it.each([
    undefined,
    null,
    [],
    {},
    { enabled: null },
    { enabled: '0' },
    { enabled: 2 },
  ])('rejects invalid toggle body %j', (body) =>
    expect(() => feishuEnabled(body)).toThrow(FeishuConfigurationError),
  );
  it('bounds storage fields before database I/O without exposing values in errors', () => {
    for (const body of [
      null,
      {},
      { country: 'US' },
      { country: '', webhookUrl: 'x' },
      { country: 'US', webhookUrl: '' },
      { country: 'x'.repeat(11), webhookUrl: 'x' },
      { country: 'US', webhookUrl: 'x'.repeat(501) },
      { country: 'US', webhookUrl: 'private\0value' },
      { country: 'US', webhookUrl: 'x', enabled: 'false' },
    ])
      expect(() => feishuConfigurationChange(body)).toThrow(
        'Feishu configuration operation could not be completed',
      );
  });
  it('masks webhook credentials in both response shapes without changing other fields', () => {
    expect(displayFeishuConfiguration(fixture(), 'camel', false)).toEqual({
      ...displayFeishuConfiguration(fixture(), 'camel', true),
      webhookUrl: '***REDACTED***',
    });
    expect(displayFeishuConfiguration(fixture(), 'snake', false)).toEqual({
      ...displayFeishuConfiguration(fixture(), 'snake', true),
      webhook_url: '***REDACTED***',
    });
    expect(
      displayFeishuConfiguration(
        { ...fixture(), webhookUrl: '' },
        'camel',
        false,
      ),
    ).toHaveProperty('webhookUrl', '');
  });
  it('rejects invalid database records instead of silently omitting fields', () => {
    for (const row of [
      { ...fixture(), id: 0 },
      { ...fixture(), id: Number.MAX_SAFE_INTEGER + 1 },
      { ...fixture(), createTime: new Date(NaN) },
      { ...fixture(), webhookUrl: 'x'.repeat(501) },
    ])
      expect(() => validateFeishuRow(row)).toThrow(FeishuConfigurationError);
  });
});
