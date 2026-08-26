import { describe, expect, it } from 'vitest';

import {
  ENDPOINT_DOMAINS,
  ENDPOINTS,
  endpointsOf,
  type EndpointSpec,
} from '../src/endpoints';

/** 与总体计划 §4 P0-T1 的域端点数口径一致 */
const EXPECTED_DOMAIN_COUNTS: Record<string, number> = {
  auth: 7,
  users: 8,
  roles: 4,
  asin: 16,
  'variant-check': 4,
  monitor: 17,
  'competitor-asin': 14,
  'competitor-monitor': 3,
  'competitor-variant-check': 3,
  export: 9,
  tasks: 5,
  backup: 7,
  feishu: 6,
  'sp-api-config': 5,
  audit: 4,
  ops: 3,
  dashboard: 1,
  system: 1,
};

describe('端点注册表（契约冻结基线）', () => {
  it('恰好 117 个端点', () => {
    expect(ENDPOINTS).toHaveLength(117);
  });

  it('域划分与计划口径一致（18 域）', () => {
    expect(ENDPOINT_DOMAINS).toHaveLength(18);
    for (const [domain, count] of Object.entries(EXPECTED_DOMAIN_COUNTS)) {
      expect(endpointsOf(domain as never), domain).toHaveLength(count);
    }
  });

  it('无重复的 method+path 组合', () => {
    const keys = ENDPOINTS.map((e) => `${e.method} ${e.path}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('权限码均为 domain:action 形式', () => {
    const withPerm = ENDPOINTS.filter((e) => e.permission);
    expect(withPerm.length).toBeGreaterThan(0);
    for (const e of withPerm) {
      expect(e.permission).toMatch(/^[a-z-]+:[a-z]+$/);
    }
  });

  it('特殊行为标注合法', () => {
    const specials = new Set([
      'sse',
      'upload',
      'download',
      'timeout-120',
      'timeout-300',
      'timeout-600',
    ]);
    for (const e of ENDPOINTS) {
      for (const s of e.special ?? []) {
        expect(specials.has(s), `${e.method} ${e.path} -> ${s}`).toBe(true);
      }
    }
  });

  it('SSE 导出端点全部标记 deprecatedInNeo（决策 D5）', () => {
    const sse = ENDPOINTS.filter((e) => e.special?.includes('sse'));
    expect(sse).toHaveLength(9);
    for (const e of sse) {
      expect(e.deprecatedInNeo, `${e.method} ${e.path}`).toBe(true);
    }
  });

  it('上传端点恰为两个 import-excel', () => {
    const uploads = ENDPOINTS.filter((e) => e.special?.includes('upload'));
    expect(uploads.map((e) => e.path).sort()).toEqual([
      '/competitor/variant-groups/import-excel',
      '/variant-groups/import-excel',
    ]);
  });

  it('监控统计路由顺序约束：具体统计路径先于 :id（文档化断言）', () => {
    const monitorPaths = endpointsOf('monitor').map((e) => e.path);
    const idIndex = monitorPaths.indexOf('/monitor-history/:id');
    const statsIndex = monitorPaths.indexOf('/monitor-history/statistics');
    expect(statsIndex).toBeGreaterThanOrEqual(0);
    expect(idIndex).toBeGreaterThan(statsIndex);
  });

  it('认证标记分布快照（契约冻结如实记录，含 43 个未挂认证端点）', () => {
    const unauthenticated = ENDPOINTS.filter((e) => !e.auth);
    expect(unauthenticated).toHaveLength(43);
    const byDomain = unauthenticated.reduce<Record<string, number>>(
      (acc, e) => {
        acc[e.domain] = (acc[e.domain] ?? 0) + 1;
        return acc;
      },
      {},
    );
    expect(byDomain).toEqual({
      auth: 1, // login
      asin: 11,
      'variant-check': 2,
      monitor: 17,
      feishu: 6,
      'sp-api-config': 5,
      system: 1,
    } as Record<string, number>);
  });
});

describe('端点规格类型完整性', () => {
  it('每个端点必填字段齐备', () => {
    for (const e of ENDPOINTS satisfies EndpointSpec[]) {
      expect(e.method).toBeTruthy();
      expect(e.path.startsWith('/')).toBe(true);
      expect(e.domain).toBeTruthy();
      expect(typeof e.auth).toBe('boolean');
      expect(e.controller).toBeTruthy();
    }
  });
});
