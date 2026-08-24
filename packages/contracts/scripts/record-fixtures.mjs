#!/usr/bin/env node
/**
 * 契约 golden fixture 录制脚本。
 * 对旧后端录制关键只读端点响应，作为新旧 diff 的 golden set（P0-T1）。
 *
 * 用法：
 *   LEGACY_BASE_URL=http://localhost:3001 \
 *   LEGACY_USERNAME=<用户> LEGACY_PASSWORD=<密码> \
 *   node scripts/record-fixtures.mjs
 *
 * 产物：test/fixtures/golden/<name>.json（含请求元数据与脱敏响应体）。
 * 注意：录制结果仍可能含业务数据，仅作为本地/CI 测试资产，勿外传。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE_URL = normalizeBaseUrl(
  process.env.LEGACY_BASE_URL || 'http://localhost:3001',
);
const USERNAME = process.env.LEGACY_USERNAME;
const PASSWORD = process.env.LEGACY_PASSWORD;

const SENSITIVE_KEY_PATTERN =
  /(password|token|secret|authorization|cookie|webhook|username|email|phone)/i;

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl).trim().replace(/\/+$/, '');
}

/** 与前端请求/导出层一致：去尾斜杠，并去掉重复的 /api 前缀。 */
function mergeApiUrl(baseUrl, path) {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  let normalizedPath = path.startsWith('/') ? path : `/${path}`;
  if (normalizedBase.endsWith('/api') && normalizedPath.startsWith('/api/')) {
    normalizedPath = normalizedPath.slice(4);
  }
  return `${normalizedBase}${normalizedPath}`;
}

const OUT_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'test',
  'fixtures',
  'golden',
);

/** 录制清单：关键只读端点（按计划 §4 P0-T1，可增量扩展） */
const TARGETS = [
  {
    name: 'auth-current-user',
    method: 'GET',
    path: '/api/v1/auth/current-user',
  },
  { name: 'dashboard', method: 'GET', path: '/api/v1/dashboard' },
  {
    name: 'monitor-history',
    method: 'GET',
    path: '/api/v1/monitor-history?current=1&pageSize=20',
  },
  {
    name: 'monitor-history-statistics',
    method: 'GET',
    path: '/api/v1/monitor-history/statistics',
  },
  {
    name: 'monitor-history-statistics-by-time',
    method: 'GET',
    path: '/api/v1/monitor-history/statistics/by-time',
  },
  { name: 'tasks', method: 'GET', path: '/api/v1/tasks?current=1&pageSize=20' },
  { name: 'ops-overview', method: 'GET', path: '/api/v1/ops/overview' },
  { name: 'variant-groups', method: 'GET', path: '/api/v1/variant-groups' },
  {
    name: 'competitor-variant-groups',
    method: 'GET',
    path: '/api/v1/competitor/variant-groups',
  },
  { name: 'users', method: 'GET', path: '/api/v1/users?current=1&pageSize=20' },
  { name: 'roles', method: 'GET', path: '/api/v1/roles' },
  {
    name: 'audit-logs',
    method: 'GET',
    path: '/api/v1/audit-logs?current=1&pageSize=20',
  },
  { name: 'feishu-configs', method: 'GET', path: '/api/v1/feishu-configs' },
  { name: 'sp-api-configs', method: 'GET', path: '/api/v1/sp-api-configs' },
  { name: 'system-alert', method: 'GET', path: '/api/v1/system/alert' },
  { name: 'backup-list', method: 'GET', path: '/api/v1/backup' },
  { name: 'backup-config', method: 'GET', path: '/api/v1/backup/config' },
];

function maskValue(value) {
  if (value === null || value === undefined || value === '') return value;
  return '***MASKED***';
}

/**
 * 保留 fixture 的字段与类型骨架，同时阻止凭据、Webhook 与用户 PII 落盘。
 * SP-API 显示接口的敏感性由 configKey 决定，需要额外处理 configValue。
 */
function sanitizeFixture(value) {
  if (Array.isArray(value)) return value.map(sanitizeFixture);
  if (!value || typeof value !== 'object') return value;

  const configKey = String(value.configKey || value.config_key || '');
  const sensitiveConfig = /(SECRET|TOKEN|KEY|ROLE_ARN)/i.test(configKey);
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => {
      if (
        SENSITIVE_KEY_PATTERN.test(key) ||
        (sensitiveConfig &&
          ['configValue', 'config_value', 'displayValue'].includes(key))
      ) {
        return [key, maskValue(child)];
      }
      return [key, sanitizeFixture(child)];
    }),
  );
}

async function login() {
  const res = await fetch(mergeApiUrl(BASE_URL, '/api/v1/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  if (!res.ok) {
    throw new Error(`登录失败: HTTP ${res.status}`);
  }
  const body = await res.json().catch(() => ({}));
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  const token = body?.data?.token;
  if (!cookie && !token) {
    throw new Error('登录响应中无 cookie 或 token');
  }
  return { cookie, token };
}

async function record(auth, target) {
  const headers = {};
  if (auth.cookie) headers.Cookie = auth.cookie;
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  const startedAt = Date.now();
  const res = await fetch(mergeApiUrl(BASE_URL, target.path), {
    method: target.method,
    headers,
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { __raw: text };
  }
  return {
    name: target.name,
    request: { method: target.method, path: target.path },
    status: res.status,
    durationMs: Date.now() - startedAt,
    capturedAt: new Date().toISOString(),
    baseUrl: BASE_URL,
    body: sanitizeFixture(body),
  };
}

async function main() {
  if (!USERNAME || !PASSWORD) {
    console.error('缺少 LEGACY_USERNAME / LEGACY_PASSWORD');
    process.exit(1);
  }
  await mkdir(OUT_DIR, { recursive: true });
  const auth = await login();
  console.info(`登录成功，开始录制 ${TARGETS.length} 个端点 → ${OUT_DIR}`);

  let ok = 0;
  for (const target of TARGETS) {
    try {
      const record$1 = await record(auth, target);
      await writeFile(
        join(OUT_DIR, `${target.name}.json`),
        JSON.stringify(record$1, null, 2) + '\n',
      );
      console.info(
        `  ✓ ${target.name} (${record$1.status}, ${record$1.durationMs}ms)`,
      );
      ok += 1;
    } catch (error) {
      console.error(`  ✗ ${target.name}: ${error.message}`);
    }
  }
  console.info(`完成：${ok}/${TARGETS.length}`);
  if (ok === 0) {
    process.exit(1);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}

export { mergeApiUrl, sanitizeFixture };
