import {
  createDurationMetricsAccumulator,
  finalizeDurationMetrics,
  type AuthSessionRecord,
  type AuthUserRecord,
  type MonitorAnalyticsQuery,
  type MonitorAnalyticsQueryRepositoryPort,
  type MonitorAnalyticsQueryUnit,
} from '@asin-monitor/db';
import { vi } from 'vitest';

export function monitorAnalyticsFixture() {
  const user: AuthUserRecord = {
    id: 'analytics-109',
    username: 'analytics-109',
    realName: null,
    status: 'ACTIVE',
    lockedUntil: null,
    forcePasswordChange: false,
    passwordExpiresAt: null,
    lastLoginTime: null,
    lastLoginIp: null,
    passwordChangedAt: null,
    failedLoginAttempts: 0,
    createTime: null,
    updateTime: null,
  };
  const session: AuthSessionRecord = {
    id: 'analytics-session-109',
    userId: user.id,
    status: 'ACTIVE',
    expiresAt: new Date('2099-01-01'),
    userAgent: null,
    ipAddress: null,
    rememberMe: false,
    createdAt: new Date(),
    lastActiveAt: new Date(),
  };
  const permissions = ['monitor:read', 'analytics:read'];
  const metrics = finalizeDurationMetrics(createDurationMetricsAccumulator());
  const unit: MonitorAnalyticsQueryUnit = {
    lockOperator: vi.fn(async () => user),
    lockSession: vi.fn(async () => session),
    operatorPermissionCodes: vi.fn(async () => permissions),
    duration: vi.fn(async (query: MonitorAnalyticsQuery) => {
      let data: Record<string, unknown> | Record<string, unknown>[] = [];
      if (query.operation === 'statistics')
        data = {
          totalChecks: 0,
          brokenCount: 0,
          normalCount: 0,
          groupCount: 0,
          asinCount: 0,
          totalDurationHours: 0,
          abnormalDurationHours: 0,
          normalDurationHours: 0,
          ratioAllAsin: 0,
          ratioAllTime: 0,
        };
      if (query.operation === 'all-countries-summary')
        data = { timeRange: '', ...metrics };
      if (query.operation === 'region-summary')
        data = ['US', 'EU_TOTAL', 'UK', 'DE', 'FR', 'ES', 'IT'].map(
          (regionCode) => ({
            regionCode,
            region: regionCode,
            timeRange: '',
            ...metrics,
          }),
        );
      return { data, source: 'raw' as const };
    }),
    counts: vi.fn(async () => []),
    peak: vi.fn(async () => ({
      peakBroken: 0,
      peakTotal: 0,
      peakRate: 0,
      offPeakBroken: 0,
      offPeakTotal: 0,
      offPeakRate: 0,
      peakAbnormalDurationHours: 0,
      peakDurationHours: 0,
      peakDurationRate: 0,
      offPeakAbnormalDurationHours: 0,
      offPeakDurationHours: 0,
      offPeakDurationRate: 0,
    })),
    period: vi.fn(async (query: MonitorAnalyticsQuery) => ({
      data:
        query.operation === 'period-summary/details'
          ? []
          : {
              list: [],
              total: 0,
              current: query.current,
              pageSize: query.pageSize,
            },
      source: 'raw' as const,
    })),
    abnormal: vi.fn(async () => ({
      data: { timeGranularity: 'day' as const, data: [], summary: [] },
      source: 'raw' as const,
    })),
  };
  const repository: MonitorAnalyticsQueryRepositoryPort = {
    read: vi.fn(async (action) => action(unit)),
  };
  const auth = {
    findUserById: vi.fn(async () => ({
      ...structuredClone(user),
      status: 'ACTIVE',
      forcePasswordChange: false,
      passwordExpiresAt: null,
    })),
    findSessionById: vi.fn(async () => ({
      ...structuredClone(session),
      status: 'ACTIVE',
      expiresAt: new Date('2099-01-01'),
    })),
    getPermissionCodes: vi.fn(async () => ['monitor:read', 'analytics:read']),
    getRoles: vi.fn(async () => [
      { id: 'analytics-reader-109', code: 'READONLY', name: 'Fixture' },
    ]),
    touchSession: vi.fn(),
    revokeSession: vi.fn(),
    markPasswordChangeRequired: vi.fn(),
    listSessionsByUserId: vi.fn(async () => []),
    revokeOwnedSession: vi.fn(async () => true),
  };
  const values = new Map<string, string>();
  const redis = {
    get: vi.fn(async () => null),
    setex: vi.fn(),
    del: vi.fn(),
    eval: vi.fn(
      async (script: string, keys: string[], args: (string | number)[]) => {
        if (script.includes('STRLEN')) {
          const value = values.get(keys[0]);
          return value && Buffer.byteLength(value) <= Number(args[0])
            ? value
            : null;
        }
        values.set(keys[0], String(args[0]));
        return 'OK';
      },
    ),
  };
  return { user, session, permissions, unit, repository, auth, redis, values };
}
