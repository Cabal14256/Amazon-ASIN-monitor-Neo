import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  parseTaskId,
  parseTaskQuery,
  publicTaskResult,
  serializeTask,
} from '../src/tasks/task-query-values';
import { backupCreationFixture } from './helpers/backup-creation-fixtures';
import { taskFixture } from './helpers/task-query-fixtures';

function legacySerializer() {
  const base = resolve(__dirname, '../../../server/src');
  function load(
    path: string,
    imports: Record<string, unknown> = {},
    appendix = '',
  ) {
    const filename = resolve(base, path),
      native = createRequire(filename);
    const module = { exports: {} as Record<string, (...args: any[]) => any> };
    runInNewContext(readFileSync(filename, 'utf8') + appendix, {
      module,
      exports: module.exports,
      process: { env: { TASK_REGISTRY_MEMORY_ONLY: 'true' } },
      require: (name: string) =>
        imports[name] ??
        (name.includes('logger') || name.includes('config/')
          ? {}
          : native(name)),
    });
    return module.exports;
  }
  const registry = load('services/taskRegistryService.js');
  const results = load('services/taskResultService.js');
  return load(
    'controllers/taskController.js',
    {
      '../services/taskRegistryService': registry,
      '../services/taskResultService': results,
      ...Object.fromEntries(
        [
          'taskQueueRegistry',
          'exportTaskQueue',
          'batchCheckTaskQueue',
          'batchDeleteTaskQueue',
          'importTaskQueue',
          'backupTaskQueue',
          'variantCheckTaskQueue',
          'websocketService',
        ].map((name) => [`../services/${name}`, {}]),
      ),
    },
    '\nmodule.exports.fixtureSerialize = sanitizeTaskForResponse;',
  ).fixtureSerialize;
}

describe('historical backup creation display', () => {
  it('labels a verified old completed result as filename time without changing its stored proof or terminal state', () => {
    const published = backupCreationFixture('owner-95');
    const task = taskFixture({
      ...published.data,
      status: 'completed',
      result: published.result,
    });
    const original = structuredClone(task);
    const displayed = serializeTask(task);
    expect(displayed).toMatchObject({
      status: 'completed',
      result: { createdAt: published.result.createdAt, timeSource: 'filename' },
    });
    expect(JSON.stringify(displayed)).not.toContain('backupCreationCommit');
    expect(task).toEqual(original);
  });
  it.each([
    'userId',
    'taskId',
    'taskCreatedAt',
    'filename',
    'createdAt',
    'missing-proof',
  ])(
    'shows an unavailable execution-time source when an old %s cannot be verified',
    (field) => {
      const published = backupCreationFixture('owner-95');
      const result: Record<string, unknown> = structuredClone(published.result);
      if (field === 'missing-proof') delete result.backupCreationCommit;
      else if (field === 'filename' || field === 'createdAt')
        result[field] = 'unverified';
      else
        (result.backupCreationCommit as Record<string, unknown>)[field] =
          'unverified';
      const task = taskFixture({
        ...published.data,
        status: 'completed',
        result,
      });
      const original = structuredClone(task);
      expect(serializeTask(task)).toMatchObject({
        status: 'completed',
        result: { timeSource: 'unavailable' },
      });
      expect(task).toEqual(original);
    },
  );
  it('keeps actual execution windows and unrelated restore output unchanged', () => {
    const published = backupCreationFixture('owner-95');
    const execution = {
      timeSource: 'dump-start',
      dumpStartedAt: '2026-09-03T01:00:00.123Z',
      dumpCompletedAt: '2026-09-03T01:02:00.456Z',
      publicationStartedAt: '2026-09-03T01:03:00.789Z',
    };
    const result = {
      ...published.result,
      createdAt: execution.dumpStartedAt,
      timeSource: 'dump-start',
      execution,
    };
    expect(
      serializeTask(
        taskFixture({ ...published.data, status: 'completed', result }),
      ).result,
    ).toMatchObject({ timeSource: 'dump-start', execution });
    expect(
      serializeTask(
        taskFixture({
          taskType: 'backup',
          taskSubType: 'restore',
          status: 'completed',
          result: { createdAt: published.result.createdAt },
        }),
      ).result,
    ).toEqual({ createdAt: published.result.createdAt });
  });
  it('refuses filename-time provenance when available immutable queue parameters do not match the original digest', () => {
    const published = backupCreationFixture('owner-95');
    const task = taskFixture({
      ...published.data,
      status: 'completed',
      result: published.result,
    });
    const queued = {
      ...task,
      backupData: {
        ...published.data,
        params: { description: 'different request' },
      },
    };
    const original = structuredClone(queued);
    expect(serializeTask(queued).result).toMatchObject({
      timeSource: 'unavailable',
    });
    expect(queued).toEqual(original);
  });
});
describe('task query values and actual Legacy public model', () => {
  it('recursively removes competitor private completion evidence without changing stored results', () => {
    const result = {
      success: true,
      totalChecked: 1,
      _competitorMonitorCommit: { version: 1, requestHash: 'private-proof' },
      details: [
        {
          total: 1,
          _competitorMonitorCommit: { requestHash: 'nested-private' },
        },
      ],
    };
    const task = taskFixture({
      taskType: 'competitor-monitor',
      taskSubType: 'competitor',
      result,
    });
    expect(serializeTask(task).result).toEqual({
      success: true,
      totalChecked: 1,
      details: [{ total: 1 }],
    });
    expect(task.result).toEqual(result);
    expect(JSON.stringify(publicTaskResult(result))).not.toContain('private');
  });
  const legacy = legacySerializer();
  it.each([
    'pending',
    'processing',
    'cancelling',
    'completed',
    'failed',
    'cancelled',
  ] as const)('matches complete Legacy JSON for %s', (status) => {
    const task = taskFixture({
      status,
      progress: 42,
      result: {
        total: 5,
        successCount: 4,
        errors: [{ row: 2, message: '条目无效' }],
      },
      error: status === 'failed' ? '检查失败' : null,
    });
    expect(serializeTask(task)).toEqual(legacy(task));
  });
  it.each([
    null,
    false,
    0,
    '',
    ['sample'],
    { summary: '已完成', warnings: [], verificationPassed: true },
  ])('matches Legacy nullable result %j', (result) => {
    const task = taskFixture({ result });
    expect(serializeTask(task)).toEqual(legacy(task));
  });
  it('keeps business fields but removes paths and secrets recursively without changing storage', () => {
    const task = taskFixture({
      result: {
        filepath: 'C:\\private\\report.csv',
        filename: 'C:\\private\\report.csv',
        downloadUrl: 'https://unsafe.example/token',
        total: 10,
        details: [
          { filepath: '/private/input', token: 'private-token', success: true },
        ],
        metadata: {
          authorization: 'private-auth',
          password: 'private-password',
          clientSecret: 'private-secret',
          path: '/private',
        },
      },
    });
    const before = structuredClone(task),
      result = serializeTask(task);
    expect(result.filename).toBe('report.csv');
    expect(result.downloadUrl).toBe('/api/v1/tasks/task-95/download');
    expect(result.result).toEqual({
      filename: 'report.csv',
      downloadUrl: result.downloadUrl,
      total: 10,
      details: [{ success: true }],
      metadata: {},
    });
    expect(result).not.toHaveProperty('userId');
    expect(result).not.toHaveProperty('revision');
    expect(task).toEqual(before);
  });
  it('uses the encoded current task ID for its own download URL', () => {
    expect(
      serializeTask(
        taskFixture({
          taskId: 'A/B?C',
          result: { filepath: '/private/result.csv' },
        }),
      ),
    ).toMatchObject({
      filename: 'result.csv',
      downloadUrl: '/api/v1/tasks/A%2FB%3FC/download',
    });
  });
  it('does not advertise the unsupported task download endpoint for backup results', () => {
    const artifact = 'backup_20260927-020000-abcdef01-primary.dump';
    const backup = taskFixture({
      taskType: 'backup',
      taskSubType: 'create',
      status: 'completed',
      result: { filename: artifact, operation: 'create' },
    });
    expect(serializeTask(backup)).toMatchObject({
      filename: artifact,
      downloadUrl: null,
    });
    expect(
      serializeTask({
        ...backup,
        result: {
          filename: artifact,
          filepath: '/private/backup.dump',
          downloadUrl: '/legacy/download',
        },
      }),
    ).toMatchObject({
      filename: artifact,
      downloadUrl: null,
      result: { filename: artifact, downloadUrl: null },
    });
  });
  it.each(['', 'x'.repeat(201), 'a\u0000b', undefined])(
    'rejects invalid task identifier %j',
    (value) => expect(() => parseTaskId(value)).toThrow(),
  );
  it.each([
    { limit: 0 },
    { limit: 201 },
    { limit: 1.5 },
    { limit: 'no' },
    { status: [] },
    { status: 'x'.repeat(101) },
    { userId: 'foreign' },
  ])('rejects invalid query %j', (value) =>
    expect(() => parseTaskQuery(value)).toThrow(),
  );
  it('preserves task identity and the frozen query defaults/limits', () => {
    expect(parseTaskId(' task:95 ')).toBe(' task:95 ');
    expect(parseTaskQuery({})).toEqual({ status: 'all', limit: 50 });
    expect(parseTaskQuery({ status: 'active', limit: '200' })).toEqual({
      status: 'active',
      limit: 200,
    });
  });
  it('rejects oversized and deeply nested results before HTTP serialization', () => {
    expect(() => publicTaskResult({ value: 'x'.repeat(262144) })).toThrow();
    let nested: unknown = {};
    for (let index = 0; index < 22; index++) nested = { nested };
    expect(() => publicTaskResult(nested)).toThrow();
  });
});
