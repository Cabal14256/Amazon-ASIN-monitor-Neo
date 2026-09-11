import { importExcelResultSchema } from '@asin-monitor/contracts';
import type {
  AsinImportRepositoryPort,
  AsinImportUnit,
  BatchAsinItem,
} from '@asin-monitor/db';
import { isAsinImportTaskData } from '@asin-monitor/import';
import jwt from 'jsonwebtoken';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASIN_IMPORT_REPOSITORY } from '../src/asin/asin-import.service';
import { AsinModule } from '../src/asin/asin.module';
import { ApplicationImportStorage } from '../src/import/import-storage.module';
import { TaskQueryRuntime } from '../src/tasks/task-query.runtime';
import { sessionApp } from './helpers/session-app';
import {
  taskAuthFixture,
  taskSessionId,
  taskUserId,
} from './helpers/task-query-fixtures';

const csv =
  '变体组名称,国家,站点,品牌,ASIN,ASIN类型\nGroup,US,Shop,Brand,b000000001,1';
function form(mode?: string) {
  const boundary = 'asin-import-http-fixture';
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n${
      mode === undefined
        ? ''
        : `--${boundary}\r\nContent-Disposition: form-data; name="useAsync"\r\n\r\n${mode}\r\n`
    }--${boundary}--\r\n`,
  };
}
describe('ASIN import authenticated HTTP acceptance and synchronous execution', () => {
  let app: Awaited<ReturnType<typeof sessionApp>>;
  let auth: ReturnType<typeof taskAuthFixture>;
  let unit: ReturnType<typeof makeUnit>;
  let directory: string;
  let transactionOpen = false;
  let headers: Record<string, string>;
  const create = vi.fn(async (input: Record<string, unknown>) => ({
    ...input,
    createdAt: '2026-09-01T00:00:00.000Z',
  }));
  const enqueue = vi.fn(async (_data: unknown) => undefined);
  const openImport = vi.fn((ensureOpen: () => void) => {
    expect(transactionOpen).toBe(false);
    ensureOpen();
    return { store: { create }, enqueue };
  });
  function makeUnit() {
    return {
      lockOperator: vi.fn(async () => auth.user),
      lockSession: vi.fn(async () => auth.session),
      operatorPermissionCodes: vi.fn(async () => ['asin:write']),
      findOrCreateImportGroup: vi.fn(async () => 'import-group'),
      writeImportChunk: vi.fn(async (items: BatchAsinItem[]) => ({
        successCount: items.length,
        failedCount: 0,
        errors: [],
      })),
    };
  }
  beforeEach(async () => {
    vi.clearAllMocks();
    create.mockImplementation(async (input) => ({
      ...input,
      createdAt: '2026-09-01T00:00:00.000Z',
    }));
    enqueue.mockResolvedValue(undefined);
    auth = taskAuthFixture();
    auth.repository.getPermissionCodes.mockResolvedValue([
      'asin:write',
    ] as never);
    unit = makeUnit();
    transactionOpen = false;
    directory = await mkdtemp(join(tmpdir(), 'neo-import-route-'));
    const repository: AsinImportRepositoryPort = {
      transaction: async (action) => {
        transactionOpen = true;
        try {
          return await action(unit as unknown as AsinImportUnit);
        } finally {
          transactionOpen = false;
        }
      },
    };
    app = await sessionApp(
      auth.repository,
      { IMPORT_STORAGE_DIRECTORY: directory },
      (builder) =>
        builder
          .overrideProvider(ASIN_IMPORT_REPOSITORY)
          .useValue(repository)
          .overrideProvider(TaskQueryRuntime)
          .useValue({ openImport }),
      [AsinModule],
    );
    headers = {
      authorization: `Bearer ${jwt.sign(
        { userId: taskUserId, sessionId: taskSessionId },
        app.env.JWT_SECRET,
        { expiresIn: '1h' },
      )}`,
      origin: app.env.CORS_ORIGIN,
    };
  });
  afterEach(async () => {
    await app?.app.close();
    if (directory) await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });
  const request = (mode?: string, authHeaders = headers) => {
    const data = form(mode);
    return app.http.inject({
      method: 'POST',
      url: '/api/v1/variant-groups/import-excel',
      headers: { ...authHeaders, 'content-type': data.contentType },
      payload: data.body,
    });
  };
  it('defaults to async, preserving the file and handing off only a small verified reference', async () => {
    const response = await request();
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const envelope = response.json();
    importExcelResultSchema.parse(envelope);
    expect(envelope).toEqual({
      success: true,
      errorCode: 0,
      data: { taskId: expect.any(String), status: 'pending' },
    });
    expect(create).toHaveBeenCalledWith({
      taskId: envelope.data.taskId,
      userId: taskUserId,
      taskType: 'import',
      taskSubType: 'asin',
      title: 'ASIN导入',
      message: '导入任务已创建，等待处理',
    });
    const payload = enqueue.mock.calls[0][0];
    expect(isAsinImportTaskData(payload)).toBe(true);
    expect(JSON.stringify(payload).length).toBeLessThan(1024);
    expect(unit.lockOperator).toHaveBeenCalledTimes(2);
    expect(unit.writeImportChunk).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([
      `import-${envelope.data.taskId}.csv`,
    ]);
  });
  it('runs the real file parser and write flow synchronously when useAsync=false follows the file', async () => {
    const response = await request('false');
    expect(response.statusCode).toBe(200);
    importExcelResultSchema.parse(response.json());
    expect(response.json().data).toEqual({
      total: 1,
      processedCount: 1,
      successCount: 1,
      failedCount: 0,
      missingCount: 0,
      verificationPassed: true,
    });
    expect(unit.writeImportChunk.mock.calls[0][0][0]).toMatchObject({
      asin: 'B000000001',
      country: 'US',
      site: 'Shop',
      brand: 'Brand',
      parentId: 'import-group',
      asinType: '1',
    });
    expect(openImport).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });
  it('rejects missing authentication, cached missing permission and foreign origin before upload', async () => {
    expect((await request(undefined, {})).statusCode).toBe(401);
    expect(
      (
        await request(undefined, {
          ...headers,
          origin: 'https://foreign.example',
        })
      ).statusCode,
    ).toBe(403);
    auth.repository.getPermissionCodes.mockResolvedValue([] as never);
    expect((await request()).statusCode).toBe(403);
    expect(unit.findOrCreateImportGroup).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });
  it('uses current permission inside the acceptance transaction', async () => {
    unit.operatorPermissionCodes.mockResolvedValue([]);
    expect((await request()).statusCode).toBe(403);
    expect(openImport).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });
  it('rechecks a permission revoked during upload and deletes the uploaded file', async () => {
    const storage = app.app.get(ApplicationImportStorage);
    const original = storage.save.bind(storage);
    vi.spyOn(storage, 'save').mockImplementation(async (...args) => {
      const file = await original(...args);
      unit.operatorPermissionCodes.mockResolvedValue([]);
      return file;
    });
    expect((await request()).statusCode).toBe(403);
    expect(unit.lockOperator).toHaveBeenCalledTimes(2);
    expect(create).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([]);
  });
  it.each(['create', 'enqueue'])(
    'retains the input and returns its lookup UUID after an uncertain %s acknowledgement',
    async (stage) => {
      if (stage === 'create')
        create.mockRejectedValueOnce(new Error('fixture acknowledgement lost'));
      else
        enqueue.mockRejectedValueOnce(
          new Error('fixture acknowledgement lost'),
        );
      const response = await request();
      expect(response.statusCode).toBe(500);
      expect(response.json()).toMatchObject({
        success: false,
        errorCode: 500,
        data: { taskId: expect.any(String), status: 'unknown' },
      });
      expect(await readdir(directory)).toEqual([
        `import-${response.json().data.taskId}.csv`,
      ]);
      expect(response.body).not.toContain('fixture acknowledgement lost');
    },
  );
  it('does not retain synchronous input on database failure or expose driver details', async () => {
    unit.findOrCreateImportGroup.mockRejectedValueOnce(
      new Error('fixture-driver-sensitive-payload'),
    );
    const response = await request('false');
    expect(response.statusCode).toBe(500);
    expect(await readdir(directory)).toEqual([]);
    expect(response.body).not.toContain('fixture-driver-sensitive-payload');
    expect(JSON.stringify(app.logger.error.mock.calls)).not.toContain(
      'fixture-driver-sensitive-payload',
    );
  });
});
