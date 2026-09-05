import { SpApiError } from './errors';
import type { Credentials, SpApiConfig } from './types';
const fields = {
  lwaClientId: 'LWA_CLIENT_ID',
  lwaClientSecret: 'LWA_CLIENT_SECRET',
  refreshToken: 'REFRESH_TOKEN',
  accessKeyId: 'ACCESS_KEY_ID',
  secretAccessKey: 'SECRET_ACCESS_KEY',
  sessionToken: 'SESSION_TOKEN',
} as const;
export function resolveConfig(
  env: Readonly<Record<string, unknown>>,
  database: Readonly<Record<string, unknown>> = {},
): SpApiConfig {
  const text = (value: unknown) =>
    typeof value === 'string'
      ? value.trim()
      : typeof value === 'boolean'
      ? String(value)
      : '';
  const first = (...values: unknown[]) => values.map(text).find(Boolean) ?? '';
  const regions = {} as SpApiConfig['regions'];
  for (const region of ['US', 'EU'] as const) {
    const credentials = {} as Credentials;
    for (const [key, field] of Object.entries(fields)) {
      const regional = `SP_API_${region}_${field}`;
      const global = `SP_API_${field}`;
      Object.assign(credentials, {
        [key]: first(
          database[regional],
          database[global],
          env[regional],
          env[global],
        ),
      });
    }
    regions[region] = credentials;
  }
  // Unlike credential fields, an explicitly stored empty/false flag disables
  // signing. Only an absent/null DB flag falls back to the environment.
  const databaseFlag = database.SP_API_USE_AWS_SIGNATURE;
  const flag =
    databaseFlag === null || databaseFlag === undefined
      ? env.SP_API_USE_AWS_SIGNATURE
      : databaseFlag;
  return {
    regions,
    useAwsSignature: flag === true || flag === 'true' || flag === '1',
  };
}
export function snapshotConfig(config: SpApiConfig): SpApiConfig {
  if (!config || typeof config.useAwsSignature !== 'boolean')
    throw new SpApiError('INVALID_CONFIG');
  const regions = {} as SpApiConfig['regions'];
  for (const region of ['US', 'EU'] as const) {
    const values = config.regions?.[region];
    if (!values) throw new SpApiError('INVALID_CONFIG');
    const copy = {} as Credentials;
    for (const key of Object.keys(fields) as (keyof Credentials)[]) {
      const value = values[key] ?? '';
      if (
        typeof value !== 'string' ||
        value.length > 4096 ||
        /[\r\n\x00]/.test(value)
      )
        throw new SpApiError('INVALID_CONFIG');
      copy[key] = value.trim();
    }
    regions[region] = Object.freeze(copy);
  }
  return Object.freeze({
    useAwsSignature: config.useAwsSignature,
    regions: Object.freeze(regions),
  });
}
