import type { TaskState } from '@asin-monitor/db';
import {
  ImportResultStore,
  importTaskPreview,
  normalizeImportTaskResult,
  type AsinImportTaskData,
} from '@asin-monitor/import';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplicationImportResults } from '../src/import/import-storage.module';
import { TaskQueryModule } from '../src/tasks/task-query.module';
import { TaskQueryRuntime } from '../src/tasks/task-query.runtime';
import { sessionApp } from './helpers/session-app';
import {
  taskAuthFixture,
  taskFixture,
  taskSessionId,
  taskUserId,
} from './helpers/task-query-fixtures';

describe('owned complete import result download', () => {
  let app: Awaited<ReturnType<typeof sessionApp>>;
  let auth: ReturnType<typeof taskAuthFixture>;
  let directory: string,
    headers: Record<string, string>,
    task: TaskState,
    data: AsinImportTaskData;
  const full = normalizeImportTaskResult(
    {
      total: 1000,
      processedCount: 1000,
      successCount: 0,
      failedCount: 1000,
      missingCount: 0,
      verificationPassed: true,
      errors: Array.from({ length: 1000 }, (_, i) => ({
        row: i + 2,
        message: `无效记录 ${i} ${'值'.repeat(1000)}`,
      })),
    },
    'source.csv',
  );
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'neo-download-'));
    auth = taskAuthFixture();
    const taskId = randomUUID();
    data = {
      taskId,
      userId: taskUserId,
      taskType: 'import',
      taskSubType: 'asin',
      title: 'ASIN导入',
      createdAt: '2026-09-01T00:00:00.000Z',
      file: {
        taskId,
        extension: 'csv',
        originalFilename: 'source.csv',
        sha256: 'a'.repeat(64),
        bytes: 1,
      },
    };
    const report = await new ImportResultStore(directory).save(
      data,
      full,
      new AbortController().signal,
    );
    task = taskFixture({
      ...data,
      status: 'completed',
      result: importTaskPreview(full, report),
    });
    app = await sessionApp(
      auth.repository,
      { IMPORT_STORAGE_DIRECTORY: directory },
      (builder) =>
        builder.overrideProvider(TaskQueryRuntime).useValue({
          open: () => ({
            store: { read: async () => task },
            findJob: async () => null,
          }),
        }),
      [TaskQueryModule],
    );
    headers = {
      authorization: `Bearer ${jwt.sign(
        { userId: taskUserId, sessionId: taskSessionId },
        app.env.JWT_SECRET,
        { expiresIn: '1h' },
      )}`,
    };
  });
  afterEach(async () => {
    await app?.app.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  const get = (requestHeaders = headers) =>
    app.http.inject({
      method: 'GET',
      url: `/api/v1/tasks/${data.taskId}/download`,
      headers: requestHeaders,
    });
  it('serves every error through the canonical task link with safe attachment headers', async () => {
    const detail = await app.http.inject({
      method: 'GET',
      url: `/api/v1/tasks/${data.taskId}`,
      headers,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().data.downloadUrl).toBe(
      `/api/v1/tasks/${data.taskId}/download`,
    );
    expect(detail.json().data.result.errors.length).toBeLessThan(100);
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(full);
    expect(response.headers).toMatchObject({
      'cache-control': 'no-store',
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'content-disposition': `attachment; filename="import-result-${data.taskId}.json"`,
    });
    expect(Number(response.headers['content-length'])).toBe(
      response.rawPayload.length,
    );
  });
  it('checks login, current session and task owner before opening any file', async () => {
    const verify = vi.spyOn(
      app.app.get(ApplicationImportResults),
      'verifiedPath',
    );
    expect((await get({})).statusCode).toBe(401);
    auth.session.status = 'REVOKED';
    expect((await get()).statusCode).toBe(403);
    auth.session.status = 'ACTIVE';
    task.userId = 'another-owner';
    expect((await get()).statusCode).toBe(403);
    expect(verify).not.toHaveBeenCalled();
  });
  it.each(['pending', 'processing', 'failed', 'cancelled'] as const)(
    'does not serve a %s task',
    async (status) => {
      task.status = status;
      expect((await get()).statusCode).toBe(409);
    },
  );
  it('rejects a report reference for a different task', async () => {
    (task.result as { report: { taskId: string } }).report.taskId =
      randomUUID();
    expect((await get()).statusCode).toBe(404);
  });
  it('returns 404 for an expired file', async () => {
    await rm(join(directory, (await readdir(directory))[0]));
    expect((await get()).statusCode).toBe(404);
  });
  it('does not deliver a modified file or expose its private path', async () => {
    const path = join(directory, (await readdir(directory))[0]);
    await writeFile(path, 'corrupt');
    const response = await get();
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(directory);
    expect(response.body).not.toContain('corrupt');
  });
});
