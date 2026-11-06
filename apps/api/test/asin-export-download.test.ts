import { PgAsinQueryRepository, type TaskState } from '@asin-monitor/db';
import { ExportArtifactStore } from '@asin-monitor/export';
import { HttpException } from '@nestjs/common';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authorizeAdministration } from '../src/auth/administration-authorization';
import { TaskQueryModule } from '../src/tasks/task-query.module';
import { TaskQueryRuntime } from '../src/tasks/task-query.runtime';
import { sessionApp } from './helpers/session-app';
import {
  taskAuthFixture,
  taskFixture,
  taskSessionId,
  taskUserId,
} from './helpers/task-query-fixtures';

vi.mock('../src/auth/administration-authorization', () => ({
  authorizeAdministration: vi.fn(),
}));

describe('ASIN export download authorization and artifact integrity', () => {
  let app: Awaited<ReturnType<typeof sessionApp>>;
  let task: TaskState;
  let directory: string;
  let path: string;
  let headers: Record<string, string>;
  const payload = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(PgAsinQueryRepository.prototype, 'read').mockImplementation(
      async (operation) => operation({} as never),
    );
    directory = await mkdtemp(join(tmpdir(), 'neo-export-download-'));
    const taskId = randomUUID();
    const artifacts = new ExportArtifactStore(directory);
    const partial = await artifacts.temporary(taskId);
    await new Promise<void>((resolve, reject) =>
      partial.stream.end(payload, (error?: Error) =>
        error ? reject(error) : resolve(),
      ),
    );
    const artifact = await artifacts.publish(
      taskId,
      partial.path,
      new AbortController().signal,
    );
    await artifacts.discard(partial.path);
    path = join(directory, artifact.key);
    task = taskFixture({
      taskId,
      status: 'completed',
      taskType: 'export',
      taskSubType: 'asin',
      result: {
        exportType: 'asin',
        filename: 'ASIN数据_2026-09-27.xlsx',
        artifact,
      },
    });
    const auth = taskAuthFixture();
    app = await sessionApp(
      auth.repository,
      { EXPORT_STORAGE_DIRECTORY: directory },
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
      url: `/api/v1/tasks/${task.taskId}/download`,
      headers: requestHeaders,
    });

  it('streams exactly the verified task artifact with a safe filename', async () => {
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload).toEqual(payload);
    expect(response.headers).toMatchObject({
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-length': String(payload.length),
    });
    expect(response.headers['content-disposition']).toContain(
      `asin-export-${task.taskId}.xlsx`,
    );
    expect(authorizeAdministration).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ userId: taskUserId }),
      'asin:read',
    );
  });

  it('denies anonymous, another owner and a revoked current grant', async () => {
    expect((await get({})).statusCode).toBe(401);
    task.userId = 'another-owner';
    expect((await get()).statusCode).toBe(403);
    task.userId = taskUserId;
    vi.mocked(authorizeAdministration).mockRejectedValueOnce(
      new HttpException('forbidden', 403),
    );
    expect((await get()).statusCode).toBe(403);
  });

  it('refuses a foreign reference, missing file and modified bytes', async () => {
    const result = task.result as { artifact: { taskId: string } };
    result.artifact.taskId = randomUUID();
    expect((await get()).statusCode).toBe(404);
    result.artifact.taskId = task.taskId;
    await writeFile(path, 'corrupt');
    expect((await get()).statusCode).toBe(404);
    await rm(path);
    expect((await get()).statusCode).toBe(404);
  });
});
