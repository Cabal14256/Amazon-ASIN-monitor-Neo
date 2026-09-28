#!/usr/bin/env node
import { createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeApiUrl } from '../packages/contracts/scripts/record-fixtures.mjs';
import benchmark from './benchmark-analytics.js';

const require = createRequire(import.meta.url);
const { atomicWrite, canonicalJson } = benchmark;
const DEFAULT_MANIFEST = fileURLToPath(
  new URL('./shadow-read-manifest.json', import.meta.url),
);
const DEFAULT_REPORT_DIR = resolve('artifacts/shadow-read-diff');
const SAFE_PATH_KEYS = new Set([
  'success',
  'errorCode',
  'data',
  'list',
  'total',
  'current',
  'pageSize',
  'meta',
  'id',
  'code',
  'name',
  'status',
  'roles',
  'permissions',
  'length',
]);
const VOLATILE_MARKER = '__SHADOW_VOLATILE__';
const MAX_JSON_DEPTH = 40;
const MAX_JSON_NODES = 20000;

function parseArgs(argv) {
  const allowed = new Set([
    'legacy-base',
    'neo-base',
    'manifest',
    'report-dir',
    'timeout-ms',
    'max-bytes',
    'allow-remote',
  ]);
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]?.replace(/^--/, '');
    if (!argv[index]?.startsWith('--') || !allowed.has(key) || key in args) {
      throw new Error('INVALID_ARGUMENTS');
    }
    if (key === 'allow-remote') {
      args[key] = true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error('INVALID_ARGUMENTS');
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function positiveInteger(value, fallback, maximum) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error('INVALID_LIMIT');
  }
  return parsed;
}

function normalizedBase(value) {
  if (!value) throw new Error('MISSING_BASE_URL');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('INVALID_BASE_URL');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error('INVALID_BASE_URL');
  }
  return url.toString().replace(/\/+$/, '');
}

function requireLocalBases(legacyBase, neoBase, allowRemote) {
  if (allowRemote) return;
  const localHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  if (
    ![legacyBase, neoBase].every((base) =>
      localHosts.has(new URL(base).hostname),
    )
  ) {
    throw new Error('REMOTE_BASE_REQUIRES_OPT_IN');
  }
}

function apiUrl(base, path, query = {}) {
  const normalized = normalizedBase(base);
  const params = new URLSearchParams(query);
  const suffix = params.size ? '?' + params.toString() : '';
  return mergeApiUrl(normalized, '/api/v1' + path + suffix);
}

function loadRegistry() {
  try {
    return require('../packages/contracts/dist/index.js').ENDPOINTS;
  } catch {
    throw new Error('CONTRACTS_NOT_BUILT');
  }
}

function validateManifest(input, registry) {
  if (
    !input ||
    !Array.isArray(input.targets) ||
    input.targets.length < 1 ||
    input.targets.length > 50 ||
    !Array.isArray(registry)
  ) {
    throw new Error('INVALID_MANIFEST');
  }
  const names = new Set();
  return input.targets.map((target) => {
    if (
      !target ||
      typeof target !== 'object' ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(target.name) ||
      typeof target.path !== 'string' ||
      names.has(target.name)
    ) {
      throw new Error('INVALID_MANIFEST');
    }
    names.add(target.name);
    const spec = registry.find(
      (entry) =>
        entry.method === 'GET' &&
        entry.path === target.path &&
        !entry.deprecatedInNeo &&
        !entry.special?.length,
    );
    if (!spec) throw new Error('UNREGISTERED_GET');
    const params = target.params ?? {};
    const placeholders = [
      ...spec.path.matchAll(/:([a-zA-Z][a-zA-Z0-9_]*)/g),
    ].map((match) => match[1]);
    if (
      !params ||
      typeof params !== 'object' ||
      Array.isArray(params) ||
      Object.keys(params).length !== placeholders.length ||
      placeholders.some(
        (key) =>
          typeof params[key] !== 'string' ||
          !params[key] ||
          params[key].length > 200 ||
          /[\u0000-\u001f]/.test(params[key]),
      )
    ) {
      throw new Error('INVALID_MANIFEST');
    }
    const requestPath = spec.path.replace(
      /:([a-zA-Z][a-zA-Z0-9_]*)/g,
      (_, key) => encodeURIComponent(params[key]),
    );
    const query = target.query ?? {};
    if (
      !query ||
      typeof query !== 'object' ||
      Array.isArray(query) ||
      Object.entries(query).some(
        ([key, value]) =>
          !/^[a-z][a-zA-Z0-9]{0,63}$/.test(key) ||
          typeof value !== 'string' ||
          !value ||
          value.length > 200,
      )
    ) {
      throw new Error('INVALID_MANIFEST');
    }
    const requiredDataPath = target.requiredDataPath ?? [];
    if (
      !Array.isArray(requiredDataPath) ||
      requiredDataPath.some(
        (part) =>
          typeof part !== 'string' ||
          !/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(part),
      )
    ) {
      throw new Error('INVALID_MANIFEST');
    }
    const ignorePaths = target.ignorePaths ?? [];
    if (
      !Array.isArray(ignorePaths) ||
      ignorePaths.some(
        (path) =>
          typeof path !== 'string' ||
          !/^\/(?:data|meta)\//.test(path) ||
          !/^\/(?:[a-zA-Z][a-zA-Z0-9_]{0,63}|[0-9]+)(?:\/(?:[a-zA-Z][a-zA-Z0-9_]{0,63}|[0-9]+))*$/.test(
            path,
          ),
      )
    ) {
      throw new Error('INVALID_MANIFEST');
    }
    return {
      name: target.name,
      path: spec.path,
      requestPath,
      params,
      query,
      requiredDataPath,
      ignorePaths,
    };
  });
}

function readManifest(filePath, registry) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    throw new Error('INVALID_MANIFEST');
  }
  return validateManifest(parsed, registry);
}

function elapsedMs(started) {
  return Math.round(Number(process.hrtime.bigint() - started) / 1e4) / 100;
}

async function requestJson(url, options) {
  const started = process.hrtime.bigint();
  let status = 0;
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    status = response.status;
    if (status !== 200) {
      await response.body?.cancel();
      return {
        status,
        durationMs: elapsedMs(started),
        errorCode: 'HTTP_STATUS',
      };
    }
    const contentType = response.headers.get('content-type') ?? '';
    if (
      !/^application\/(?:json|[a-z0-9.+-]+\+json)(?:\s*;|$)/i.test(contentType)
    ) {
      await response.body?.cancel();
      return {
        status,
        durationMs: elapsedMs(started),
        errorCode: 'CONTENT_TYPE',
      };
    }
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
      await response.body?.cancel();
      return { status, durationMs: elapsedMs(started), errorCode: 'TOO_LARGE' };
    }
    const reader = response.body?.getReader();
    if (!reader) {
      return {
        status,
        durationMs: elapsedMs(started),
        errorCode: 'EMPTY_RESPONSE',
      };
    }
    const chunks = [];
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > options.maxBytes) {
        await reader.cancel();
        return {
          status,
          durationMs: elapsedMs(started),
          errorCode: 'TOO_LARGE',
        };
      }
      chunks.push(value);
    }
    if (size === 0) {
      return {
        status,
        durationMs: elapsedMs(started),
        errorCode: 'EMPTY_RESPONSE',
      };
    }
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
    } catch {
      return {
        status,
        durationMs: elapsedMs(started),
        errorCode: 'INVALID_JSON',
      };
    }
    let nodes = 0;
    const inspect = (value, depth = 0) => {
      nodes += 1;
      if (nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return false;
      if (Array.isArray(value)) {
        return value.every((item) => inspect(item, depth + 1));
      }
      if (value && typeof value === 'object') {
        return Object.values(value).every((item) => inspect(item, depth + 1));
      }
      return true;
    };
    if (!inspect(body)) {
      return {
        status,
        durationMs: elapsedMs(started),
        errorCode: 'JSON_COMPLEXITY',
      };
    }
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      body.success !== true ||
      body.data === undefined ||
      body.data === null
    ) {
      return {
        status,
        durationMs: elapsedMs(started),
        errorCode: 'INVALID_ENVELOPE',
      };
    }
    return {
      status,
      durationMs: elapsedMs(started),
      body,
      headers: response.headers,
    };
  } catch (error) {
    const timeout =
      error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return {
      status,
      durationMs: elapsedMs(started),
      errorCode: timeout ? 'TIMEOUT' : 'NETWORK',
    };
  }
}

function safeResult(result) {
  return {
    status: result.status,
    durationMs: result.durationMs,
    errorCode: result.errorCode ?? null,
  };
}

async function login(base, credentials, limits) {
  if (!credentials?.username || !credentials?.password) {
    return { status: 0, durationMs: 0, errorCode: 'MISSING_CREDENTIALS' };
  }
  const result = await requestJson(apiUrl(base, '/auth/login'), {
    ...limits,
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  if (result.errorCode) return result;
  const cookie =
    result.headers.getSetCookie?.()[0]?.split(';')[0] ??
    result.headers.get('set-cookie')?.split(';')[0];
  const token = result.body.data?.token;
  if (!cookie && !token) {
    return { ...safeResult(result), errorCode: 'NO_SESSION' };
  }
  const headers = { Accept: 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (token) headers.Authorization = 'Bearer ' + token;
  return { ...result, authHeaders: headers };
}

function valueAt(body, path) {
  let value = body;
  for (const part of path) {
    if (!value || typeof value !== 'object' || !(part in value))
      return undefined;
    value = value[part];
  }
  return value;
}

function hasSubstance(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  if (typeof value === 'string') return value.trim().length > 0;
  return (
    value !== null && value !== undefined && value !== false && value !== 0
  );
}

function normalizeBody(body, ignorePaths) {
  const copy = structuredClone(body);
  for (const pointer of ignorePaths) {
    const parts = pointer.slice(1).split('/');
    const parent = valueAt(copy, parts.slice(0, -1));
    const key = parts.at(-1);
    if (
      !parent ||
      typeof parent !== 'object' ||
      !Object.prototype.hasOwnProperty.call(parent, key)
    ) {
      throw new Error('VOLATILE_FIELD_MISSING');
    }
    parent[key] = VOLATILE_MARKER;
  }
  return copy;
}

function safeField(key, hmacKey) {
  if (SAFE_PATH_KEYS.has(key)) return key;
  return (
    'field#' +
    createHmac('sha256', hmacKey).update(key).digest('hex').slice(0, 8)
  );
}

function firstSafeDifference(left, right, hmacKey, path = '$') {
  if (Object.is(left, right)) return null;
  if (typeof left !== typeof right || left === null || right === null)
    return path;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return path;
    if (left.length !== right.length) return path + '.length';
    for (let index = 0; index < left.length; index += 1) {
      const found = firstSafeDifference(
        left[index],
        right[index],
        hmacKey,
        path + '[' + index + ']',
      );
      if (found) return found;
    }
    return null;
  }
  if (typeof left === 'object') {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (
      leftKeys.length !== rightKeys.length ||
      leftKeys.some((key, index) => key !== rightKeys[index])
    ) {
      return path + '.__keys';
    }
    for (const key of leftKeys) {
      const found = firstSafeDifference(
        left[key],
        right[key],
        hmacKey,
        path + '.' + safeField(key, hmacKey),
      );
      if (found) return found;
    }
    return null;
  }
  return path;
}

function responseShape(value, depth = 0) {
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      ...(depth < 2 && value.length
        ? { item: responseShape(value[0], depth + 1) }
        : {}),
    };
  }
  if (value === null) return { type: 'null' };
  if (value && typeof value === 'object') {
    return {
      type: 'object',
      keyCount: Object.keys(value).length,
      ...(depth < 2 && 'data' in value
        ? { data: responseShape(value.data, depth + 1) }
        : {}),
      ...(depth < 2 && 'list' in value
        ? { list: responseShape(value.list, depth + 1) }
        : {}),
    };
  }
  return { type: typeof value };
}

function digest(value, hmacKey) {
  return createHmac('sha256', hmacKey)
    .update(canonicalJson(value))
    .digest('hex');
}

function comparePair(target, legacy, neo, hmacKey) {
  const result = {
    name: target.path,
    path: target.path,
    legacy: safeResult(legacy),
    neo: safeResult(neo),
    differencePath: null,
    outcome: 'passed',
  };
  if (legacy.errorCode || neo.errorCode) {
    result.outcome = 'failed';
    result.differencePath = '$.__response';
    return result;
  }
  for (const side of [legacy, neo]) {
    if (
      target.requiredDataPath.length &&
      !hasSubstance(valueAt(side.body, target.requiredDataPath))
    ) {
      result.outcome = 'failed';
      result.differencePath = '$.__requiredData';
      return result;
    }
  }
  let oldBody;
  let newBody;
  try {
    oldBody = normalizeBody(legacy.body, target.ignorePaths);
    newBody = normalizeBody(neo.body, target.ignorePaths);
  } catch {
    result.outcome = 'failed';
    result.differencePath = '$.__volatileField';
    return result;
  }
  result.legacy.digest = digest(oldBody, hmacKey);
  result.neo.digest = digest(newBody, hmacKey);
  result.legacy.shape = responseShape(oldBody);
  result.neo.shape = responseShape(newBody);
  result.differencePath = firstSafeDifference(oldBody, newBody, hmacKey);
  if (result.differencePath) result.outcome = 'failed';
  return result;
}

async function runShadowDiff(config) {
  const manifest = validateManifest(
    { targets: config.targets },
    config.registry,
  );
  const legacyBase = normalizedBase(config.legacyBase);
  const neoBase = normalizedBase(config.neoBase);
  requireLocalBases(legacyBase, neoBase, config.allowRemote);
  const limits = {
    timeoutMs: positiveInteger(config.timeoutMs, 15000, 610000),
    maxBytes: positiveInteger(
      config.maxBytes,
      4 * 1024 * 1024,
      16 * 1024 * 1024,
    ),
  };
  const hmacKey = randomBytes(32);
  const [legacyAuth, neoAuth] = await Promise.all([
    login(legacyBase, config.legacyCredentials, limits),
    login(neoBase, config.neoCredentials, limits),
  ]);
  const report = {
    version: 1,
    status: 'failed',
    capturedAt: new Date().toISOString(),
    setup: { legacy: safeResult(legacyAuth), neo: safeResult(neoAuth) },
    cases: [],
  };
  if (legacyAuth.errorCode || neoAuth.errorCode) return report;
  for (const target of manifest) {
    const [legacy, neo] = await Promise.all([
      requestJson(apiUrl(legacyBase, target.requestPath, target.query), {
        ...limits,
        headers: legacyAuth.authHeaders,
      }),
      requestJson(apiUrl(neoBase, target.requestPath, target.query), {
        ...limits,
        headers: neoAuth.authHeaders,
      }),
    ]);
    report.cases.push(comparePair(target, legacy, neo, hmacKey));
  }
  report.status = report.cases.every((item) => item.outcome === 'passed')
    ? 'passed'
    : 'failed';
  return report;
}

function renderMarkdown(report) {
  const lines = [
    '# Legacy/Neo read-only diff',
    '',
    '- Status: ' + report.status,
    '- Captured: ' + report.capturedAt,
    '- Login: Legacy ' +
      (report.setup.legacy.errorCode ?? 'OK') +
      ', Neo ' +
      (report.setup.neo.errorCode ?? 'OK'),
    '',
    '| Target | Legacy HTTP/ms | Neo HTTP/ms | Result | First difference |',
    '| --- | ---: | ---: | --- | --- |',
  ];
  for (const item of report.cases) {
    lines.push(
      '| ' +
        item.name +
        ' | ' +
        item.legacy.status +
        '/' +
        item.legacy.durationMs +
        ' | ' +
        item.neo.status +
        '/' +
        item.neo.durationMs +
        ' | ' +
        item.outcome +
        ' | ' +
        (item.differencePath ?? '-') +
        ' |',
    );
  }
  return lines.join('\n') + '\n';
}

function writeReports(reportDir, report) {
  const directory = resolve(reportDir);
  atomicWrite(
    resolve(directory, 'report.json'),
    JSON.stringify(report, null, 2) + '\n',
  );
  atomicWrite(resolve(directory, 'report.md'), renderMarkdown(report));
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const registry = loadRegistry();
  const targets = readManifest(args.manifest ?? DEFAULT_MANIFEST, registry);
  const report = await runShadowDiff({
    targets,
    registry,
    legacyBase: args['legacy-base'] ?? env.LEGACY_BASE_URL,
    neoBase: args['neo-base'] ?? env.NEO_BASE_URL,
    legacyCredentials: {
      username: env.SHADOW_LEGACY_USERNAME,
      password: env.SHADOW_LEGACY_PASSWORD,
    },
    neoCredentials: {
      username: env.SHADOW_NEO_USERNAME,
      password: env.SHADOW_NEO_PASSWORD,
    },
    timeoutMs: args['timeout-ms'],
    maxBytes: args['max-bytes'],
    allowRemote: args['allow-remote'],
  });
  writeReports(args['report-dir'] ?? DEFAULT_REPORT_DIR, report);
  process.stdout.write(
    'Shadow read diff: ' +
      report.status +
      ' (' +
      report.cases.length +
      '/' +
      targets.length +
      ' cases)\n',
  );
  return report.status === 'passed' ? 0 : 1;
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(
        'Shadow read diff failed: ' +
          (/^[A-Z_]+$/.test(error?.message)
            ? error.message
            : 'INTERNAL_ERROR') +
          '\n',
      );
      process.exitCode = 1;
    });
}

export {
  apiUrl,
  comparePair,
  firstSafeDifference,
  main,
  normalizeBody,
  readManifest,
  renderMarkdown,
  requestJson,
  runShadowDiff,
  validateManifest,
  writeReports,
};
