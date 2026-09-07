import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  displaySpApiConfigs,
  isSensitiveSpApiKey,
  normalizeSpApiConfigUpdates,
  type SpApiConfigValueRecord,
} from '../src/sp-api-config/sp-api-config-values';

const legacySource = readFileSync(
  resolve(
    __dirname,
    '../../../server/src/controllers/spApiConfigController.js',
  ),
  'utf8',
);
async function legacyDisplay(
  rows: SpApiConfigValueRecord[],
  env: Record<string, string> = {},
) {
  const exported: {
    getSPAPIConfigForDisplay?: (
      request: object,
      response: { json(value: unknown): void },
    ) => Promise<void>;
  } = {};
  const records = rows.map((row) => ({
    id: row.id,
    config_key: row.configKey,
    config_value: row.configValue,
    description: row.description,
    create_time: row.createTime,
    update_time: row.updateTime,
  }));
  const dependencies: Record<string, unknown> = {
    '../models/SPAPIConfig': { findAll: async () => records },
    '../config/sp-api': {},
    '../config/monitor-config': {},
    '../config/competitor-monitor-config': {},
    '../services/variantCheckService': {},
    '../services/schedulerService': {},
    '../services/rateLimiter': {},
    '../services/errorStatsService': {},
    '../services/riskControlService': {},
    '../utils/logger': { error: () => {} },
  };
  runInNewContext(legacySource, {
    exports: exported,
    process: { env },
    require: (name: string) => {
      if (!Object.hasOwn(dependencies, name))
        throw new Error('Unexpected fixture dependency');
      return dependencies[name];
    },
  });
  let result: unknown;
  await exported.getSPAPIConfigForDisplay!(
    {},
    {
      json: (value) => {
        result = value;
      },
    },
  );
  return (JSON.parse(JSON.stringify(result)) as { data: unknown }).data;
}
const row = (
  configKey: string,
  configValue: string | null,
  overrides: Partial<SpApiConfigValueRecord> = {},
): SpApiConfigValueRecord => ({
  id: 1,
  configKey,
  configValue,
  description: null,
  createTime: null,
  updateTime: null,
  ...overrides,
});

describe('SP-API configuration value compatibility and boundaries', () => {
  it('matches all nineteen Legacy display keys, defaults and descriptions', async () => {
    expect(displaySpApiConfigs([], {}, true)).toEqual(await legacyDisplay([]));
  });
  it('preserves explicit empty DB values, ENV fallback for null, boolean text and timestamp serialization', async () => {
    const rows = [
      row('SP_API_US_REFRESH_TOKEN', ''),
      row('SP_API_EU_REFRESH_TOKEN', null, { id: 2 }),
      row('SP_API_USE_AWS_SIGNATURE', 'false', {
        id: 3,
        description: 'fixture description',
        createTime: new Date('2026-09-07T00:00:00Z'),
        updateTime: new Date('2026-09-07T01:00:00Z'),
      }),
    ];
    const env = {
      SP_API_US_REFRESH_TOKEN: 'fixture-us-token',
      SP_API_EU_REFRESH_TOKEN: 'fixture-eu-token',
      SP_API_USE_AWS_SIGNATURE: 'true',
    };
    expect(displaySpApiConfigs(rows, env, true)).toEqual(
      await legacyDisplay(rows, env),
    );
  });
  it('preserves Legacy partial masks but withholds full sensitive values from readers without write permission', async () => {
    const rows = [
      row('SP_API_US_REFRESH_TOKEN', 'fixture-token-value'),
      row('SP_API_SECRET_ACCESS_KEY', 'short', { id: 2 }),
      row('MONITOR_US_SCHEDULE_MINUTES', '15', { id: 3 }),
    ];
    const authorized = displaySpApiConfigs(rows, {}, true);
    expect(authorized).toEqual(await legacyDisplay(rows));
    const readonly = displaySpApiConfigs(rows, {}, false);
    expect(
      readonly.find((item) => item.configKey === 'SP_API_US_REFRESH_TOKEN'),
    ).toMatchObject({
      configValue: '',
      displayValue: 'fixt****alue',
      hasValue: true,
    });
    expect(
      readonly.find((item) => item.configKey === 'SP_API_SECRET_ACCESS_KEY'),
    ).toMatchObject({ configValue: '', displayValue: '****', hasValue: true });
    expect(
      readonly.find((item) => item.configKey === 'MONITOR_US_SCHEDULE_MINUTES')
        ?.configValue,
    ).toBe('15');
  });
  it('normalizes values like Legacy while bounding managed keys and duplicate case variants', () => {
    expect(
      normalizeSpApiConfigUpdates({
        configs: [
          { configKey: ' sp_api_use_aws_signature ', configValue: false },
          { configKey: 'MONITOR_US_SCHEDULE_MINUTES', configValue: 30 },
          { configKey: 'SP_API_US_REFRESH_TOKEN', configValue: null },
          {
            configKey: 'SP_API_US_SESSION_TOKEN',
            configValue: ' fixture-session ',
            description: 'fixture',
          },
        ],
      }),
    ).toEqual([
      {
        configKey: 'SP_API_USE_AWS_SIGNATURE',
        configValue: 'false',
        description: '',
      },
      {
        configKey: 'MONITOR_US_SCHEDULE_MINUTES',
        configValue: '30',
        description: '',
      },
      {
        configKey: 'SP_API_US_REFRESH_TOKEN',
        configValue: '',
        description: '',
      },
      {
        configKey: 'SP_API_US_SESSION_TOKEN',
        configValue: 'fixture-session',
        description: 'fixture',
      },
    ]);
    expect(() =>
      normalizeSpApiConfigUpdates({
        configs: [
          { configKey: 'SP_API_US_REFRESH_TOKEN', configValue: 'first' },
          { configKey: 'sp_api_us_refresh_token', configValue: 'second' },
        ],
      }),
    ).toThrow('INVALID_INPUT');
  });
  it.each([
    {},
    { configs: [] },
    { configs: [{ configKey: 'SP_API_US_REFRESH_TOKEN' }] },
    {
      configs: Array(27).fill({
        configKey: 'SP_API_US_REFRESH_TOKEN',
        configValue: '',
      }),
    },
    { configs: [{ configKey: 'constructor', configValue: 'fixture' }] },
    {
      configs: [
        { configKey: 'SP_API_US_REFRESH_TOKEN', configValue: 'x'.repeat(4097) },
      ],
    },
    {
      configs: [
        { configKey: 'SP_API_US_REFRESH_TOKEN', configValue: 'line\nvalue' },
      ],
    },
    { configs: [{ configKey: 'SP_API_US_REFRESH_TOKEN', configValue: {} }] },
    {
      configs: [
        { configKey: 'MONITOR_US_SCHEDULE_MINUTES', configValue: Infinity },
      ],
    },
    {
      configs: [
        {
          configKey: 'SP_API_US_REFRESH_TOKEN',
          configValue: '',
          description: 'x'.repeat(256),
        },
      ],
    },
  ])(
    'rejects malformed or unbounded updates without embedding values in the error',
    (input) => {
      expect(() => normalizeSpApiConfigUpdates(input)).toThrow(
        'SP-API INVALID_INPUT',
      );
    },
  );
  it('recognizes all regional/session credentials as sensitive, including non-display managed keys', () => {
    for (const key of [
      'SP_API_US_SESSION_TOKEN',
      'SP_API_EU_SECRET_ACCESS_KEY',
      'SP_API_ACCESS_KEY_ID',
      'SP_API_US_LWA_CLIENT_SECRET',
    ])
      expect(isSensitiveSpApiKey(key)).toBe(true);
    expect(isSensitiveSpApiKey('COMPETITOR_MONITOR_ENABLED')).toBe(false);
    expect(isSensitiveSpApiKey('sp_api_us_refresh_token')).toBe(true);
  });
});
