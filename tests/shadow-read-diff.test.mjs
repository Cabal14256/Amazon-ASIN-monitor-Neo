import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  apiUrl,
  comparePair,
  firstSafeDifference,
  main,
  normalizeBody,
  renderMarkdown,
  requestJson,
  runShadowDiff,
  validateManifest,
} from '../scripts/shadow-read-diff.mjs';

function responseJson(response, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(response.body ?? {}));
}

async function serverFor(targetBody, options = {}) {
  const server = createServer((request, response) => {
    if (request.url === '/api/v1/auth/login' && request.method === 'POST') {
      response.body = {
        success: true,
        errorCode: 0,
        data: { token: 'runtime-token', username: 'fixture-user' },
      };
      return responseJson(response);
    }
    if (request.url === '/api/v1/roles' && request.method === 'GET') {
      if (options.status) return responseJson(response, options.status);
      response.body = targetBody;
      return responseJson(response);
    }
    response.body = { success: false, errorCode: 404, data: null };
    return responseJson(response, 404);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    base: 'http://127.0.0.1:' + address.port + '/api',
    close: () =>
      new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

const limits = { timeoutMs: 1000, maxBytes: 1024 };

test('normalizes API bases without duplicating /api and keeps path parameters encoded', () => {
  assert.equal(
    apiUrl('http://localhost:3100/api', '/roles'),
    'http://localhost:3100/api/v1/roles',
  );
  assert.equal(
    apiUrl('http://localhost:3100/api/v1', '/roles', { pageSize: '10' }),
    'http://localhost:3100/api/v1/roles?pageSize=10',
  );
});

test('refuses remote service requests unless explicitly enabled', async () => {
  await assert.rejects(
    runShadowDiff({
      targets: [
        {
          name: 'roles',
          path: '/roles',
          query: {},
          requiredDataPath: [],
          ignorePaths: [],
        },
      ],
      registry: [{ method: 'GET', path: '/roles' }],
      legacyBase: 'https://legacy.example',
      neoBase: 'https://neo.example',
      legacyCredentials: { username: 'unused', password: 'unused' },
      neoCredentials: { username: 'unused', password: 'unused' },
    }),
    /REMOTE_BASE_REQUIRES_OPT_IN/,
  );
});

test('sanitizes difference paths while preserving stable schema fields', () => {
  assert.match(
    firstSafeDifference(
      { data: [{ password: 'one', name: 'A' }] },
      { data: [{ password: 'two', name: 'A' }] },
      'test-key',
    ),
    /^\$\.data\[0\]\.field#[0-9a-f]{8}$/,
  );
  assert.equal(
    firstSafeDifference(
      { data: { name: 'A' } },
      { data: { name: 'A' } },
      'key',
    ),
    null,
  );
  assert.deepEqual(
    normalizeBody({ data: { capturedAt: 1 } }, ['/data/capturedAt']),
    { data: { capturedAt: '__SHADOW_VOLATILE__' } },
  );
});

test('strict response reader rejects empty and non-200 responses', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/empty') {
      response.writeHead(200, { 'content-type': 'application/json' });
      return response.end();
    }
    response.writeHead(503, { 'content-type': 'application/json' });
    return response.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const empty = await requestJson(
      'http://127.0.0.1:' + port + '/empty',
      limits,
    );
    assert.equal(empty.errorCode, 'EMPTY_RESPONSE');
    const failed = await requestJson(
      'http://127.0.0.1:' + port + '/unavailable',
      limits,
    );
    assert.equal(failed.errorCode, 'HTTP_STATUS');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('rejects oversized JSON before parsing or persisting its body', async () => {
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        success: true,
        data: { secret: 's'.repeat(2048) },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const result = await requestJson(
      'http://127.0.0.1:' + server.address().port,
      { timeoutMs: 1000, maxBytes: 128 },
    );
    assert.equal(result.errorCode, 'TOO_LARGE');
    assert.equal('body' in result, false);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('manifest admits only registered GETs and requires explicit detail params', () => {
  const registry = [
    { method: 'GET', path: '/roles' },
    { method: 'GET', path: '/roles/:roleId' },
    { method: 'POST', path: '/roles' },
    { method: 'GET', path: '/export', special: ['download'] },
  ];
  assert.throws(
    () =>
      validateManifest(
        { targets: [{ name: 'roles', path: '/roles/:roleId' }] },
        registry,
      ),
    /INVALID_MANIFEST/,
  );
  assert.throws(
    () =>
      validateManifest(
        { targets: [{ name: 'export', path: '/export' }] },
        registry,
      ),
    /UNREGISTERED_GET/,
  );
  assert.throws(
    () =>
      validateManifest(
        { targets: [{ name: 'post', path: '/missing' }] },
        registry,
      ),
    /UNREGISTERED_GET/,
  );
  const [target] = validateManifest(
    {
      targets: [
        {
          name: 'role-detail',
          path: '/roles/:roleId',
          params: { roleId: 'fixture/1' },
        },
      ],
    },
    registry,
  );
  assert.equal(target.path, '/roles/:roleId');
  assert.equal(target.requestPath, '/roles/fixture%2F1');
});

test('only case-declared volatile fields are ignored', () => {
  const target = {
    name: 'roles',
    path: '/roles',
    query: {},
    requiredDataPath: ['data'],
    ignorePaths: ['/data/0/generatedAt'],
  };
  const oldResult = {
    status: 200,
    durationMs: 1,
    body: { success: true, data: [{ generatedAt: 'one', name: 'Admin' }] },
  };
  const newResult = {
    status: 200,
    durationMs: 1,
    body: { success: true, data: [{ generatedAt: 'two', name: 'Admin' }] },
  };
  assert.equal(
    comparePair(target, oldResult, newResult, 'key').outcome,
    'passed',
  );
  newResult.body.data[0].name = 'Operator';
  assert.equal(
    comparePair(target, oldResult, newResult, 'key').outcome,
    'failed',
  );
  delete newResult.body.data[0].generatedAt;
  assert.equal(
    comparePair(target, oldResult, newResult, 'key').differencePath,
    '$.__volatileField',
  );
});

test('identical sanitized fixtures produce a zero-diff report without secrets', async () => {
  const body = {
    success: true,
    errorCode: 0,
    data: [{ id: 'role-1', name: 'Admin', password: 'do-not-report' }],
  };
  const legacy = await serverFor(body);
  const neo = await serverFor(body);
  const directory = await mkdtemp(join(tmpdir(), 'shadow-read-diff-'));
  const manifest = join(directory, 'manifest.json');
  const reportDir = join(directory, 'report');
  await writeFile(
    manifest,
    JSON.stringify({
      targets: [{ name: 'roles', path: '/roles', requiredDataPath: ['data'] }],
    }),
  );
  try {
    const exitCode = await main(
      [
        '--legacy-base',
        legacy.base,
        '--neo-base',
        neo.base,
        '--manifest',
        manifest,
        '--report-dir',
        reportDir,
      ],
      {
        SHADOW_LEGACY_USERNAME: 'fixture',
        SHADOW_LEGACY_PASSWORD: 'password',
        SHADOW_NEO_USERNAME: 'fixture',
        SHADOW_NEO_PASSWORD: 'password',
      },
    );
    assert.equal(exitCode, 0);
    const report = await readFile(join(reportDir, 'report.json'), 'utf8');
    assert.match(report, /"status": "passed"/);
    assert.doesNotMatch(report, /do-not-report|runtime-token|fixture-user/);
    assert.match(await readFile(join(reportDir, 'report.md'), 'utf8'), /roles/);
    assert.match(renderMarkdown(JSON.parse(report)), /passed/);
  } finally {
    await legacy.close();
    await neo.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('status and response differences return a failing exit code and safe path', async () => {
  const legacy = await serverFor({
    success: true,
    errorCode: 0,
    data: [{ id: 'role-1', name: 'Admin' }],
  });
  const neo = await serverFor({
    success: true,
    errorCode: 0,
    data: [{ id: 'role-1', name: 'Operator' }],
  });
  const directory = await mkdtemp(join(tmpdir(), 'shadow-read-diff-'));
  const manifest = join(directory, 'manifest.json');
  await writeFile(
    manifest,
    JSON.stringify({
      targets: [{ name: 'roles', path: '/roles', requiredDataPath: ['data'] }],
    }),
  );
  try {
    const exitCode = await main(
      [
        '--legacy-base',
        legacy.base,
        '--neo-base',
        neo.base,
        '--manifest',
        manifest,
        '--report-dir',
        join(directory, 'report'),
      ],
      {
        SHADOW_LEGACY_USERNAME: 'fixture',
        SHADOW_LEGACY_PASSWORD: 'password',
        SHADOW_NEO_USERNAME: 'fixture',
        SHADOW_NEO_PASSWORD: 'password',
      },
    );
    assert.equal(exitCode, 1);
    const report = JSON.parse(
      await readFile(join(directory, 'report/report.json'), 'utf8'),
    );
    assert.equal(report.status, 'failed');
    assert.equal(report.cases[0].differencePath, '$.data[0].name');
  } finally {
    await legacy.close();
    await neo.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('pair comparison marks missing mandatory data as failed', () => {
  const target = {
    name: 'roles',
    path: '/roles',
    query: {},
    requiredDataPath: ['data'],
    ignorePaths: [],
  };
  const empty = {
    status: 200,
    durationMs: 1,
    body: { success: true, errorCode: 0, data: [] },
  };
  const result = comparePair(target, empty, empty, 'key');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.differencePath, '$.__requiredData');
});
