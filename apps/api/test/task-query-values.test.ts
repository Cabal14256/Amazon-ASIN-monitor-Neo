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
describe('task query values and actual Legacy public model', () => {
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
