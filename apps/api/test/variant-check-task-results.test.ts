import { taskInfoResultSchema } from '@asin-monitor/contracts';
import type { TaskState } from '@asin-monitor/db';
import {
  parseVariantCheckJob,
  variantCheckJobOperation,
  variantCheckResultReference,
} from '@asin-monitor/variant-check';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { taskFixture } from './helpers/task-query-fixtures';
import { checkView, variantCheckApp } from './helpers/variant-check-app';

describe('owned full check task results and downloads', () => {
  let f: Awaited<ReturnType<typeof variantCheckApp>>;
  let task: TaskState;
  let operation: ReturnType<typeof variantCheckJobOperation>;
  let data: ReturnType<typeof parseVariantCheckJob>;
  const full = {
    ...checkView,
    raw: {
      details: {
        asin: 'B000000001',
        title: '完整数据'.repeat(100_000) + '-tail',
        attributes: [{ value: 'preserved', token: 'private-fixture-token' }],
      },
      authorization: 'private-fixture-authorization',
    },
  };
  const publicFull = {
    ...checkView,
    raw: {
      details: {
        asin: 'B000000001',
        title: full.raw.details.title,
        attributes: [{ value: 'preserved' }],
      },
    },
  };
  beforeEach(async () => {
    f = await variantCheckApp();
    const now = new Date().toISOString();
    data = parseVariantCheckJob({
      taskId: randomUUID(),
      userId: f.auth.user.id,
      taskType: 'variant-check',
      taskSubType: 'asin-check',
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + 3600_000).toISOString(),
      params: { asinId: 'a1', forceRefresh: true },
    });
    operation = variantCheckJobOperation(data);
    task = taskFixture({
      ...data,
      status: 'completed',
      result: variantCheckResultReference(operation),
    });
    f.tasks.set(task.taskId, task);
    f.receipts.set(operation.operationKey, { operation, result: full });
  });
  afterEach(async () => {
    await f.app.close();
    vi.restoreAllMocks();
  });
  const get = (suffix = '', headers: Record<string, string> = f.headers) =>
    f.http.inject({
      method: 'GET',
      url: `/api/v1/tasks/${task.taskId}${suffix}`,
      headers,
    });
  const hash = (value: string | Buffer) =>
    createHash('sha256').update(value).digest('hex');
  it('returns the complete result above 256 KiB without leaking private fields', async () => {
    const response = await get();
    expect(response.statusCode).toBe(200);
    taskInfoResultSchema.parse(response.json());
    const value = response.json().data;
    expect(hash(JSON.stringify(value.result))).toBe(
      hash(JSON.stringify(publicFull)),
    );
    expect(value.filename).toBe(`check-result-${task.taskId}.json`);
    expect(value.downloadUrl).toBe(`/api/v1/tasks/${task.taskId}/download`);
    expect(response.body).not.toContain('private-fixture');
    expect(f.receipts.get(operation.operationKey)!.result).toBe(full);
    expect(f.unit.lockOperator).toHaveBeenCalledWith(task.userId);
  });
  it('downloads the complete owned JSON with content length and safe filename', async () => {
    const response = await get('/download');
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.headers['content-disposition']).toBe(
      `attachment; filename="check-result-${task.taskId}.json"`,
    );
    expect(Number(response.headers['content-length'])).toBe(
      Buffer.byteLength(JSON.stringify(publicFull)),
    );
    expect(hash(response.body)).toBe(hash(JSON.stringify(publicFull)));
  });
  it('keeps task lists compact without opening complete PostgreSQL payloads', async () => {
    const response = await f.http.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: f.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(Buffer.byteLength(response.body)).toBeLessThan(5000);
    expect(f.unit.readReceipt).not.toHaveBeenCalled();
  });
  it.each(['', '/download'])(
    'denies another owner before database receipt access (%s)',
    async (suffix) => {
      task.userId = 'other-owner';
      expect((await get(suffix)).statusCode).toBe(403);
      expect(f.unit.readReceipt).not.toHaveBeenCalled();
    },
  );
  it.each(['', '/download'])(
    'requires a current authenticated session (%s)',
    async (suffix) => {
      expect((await get(suffix, {})).statusCode).toBe(401);
      f.auth.session.status = 'REVOKED';
      expect((await get(suffix)).statusCode).toBe(403);
      expect(f.unit.readReceipt).not.toHaveBeenCalled();
    },
  );
  it.each(['', '/download'])(
    'observes revoked asin permission before loading a large result (%s)',
    async (suffix) => {
      f.permissions.splice(0);
      expect((await get(suffix)).statusCode).toBe(403);
      expect(f.unit.readReceipt).not.toHaveBeenCalled();
    },
  );
  it('rechecks authority after loading the receipt', async () => {
    f.unit.readReceipt.mockImplementation(async () => {
      f.auth.user.status = 'SUSPENDED';
      return publicFull;
    });
    expect((await get()).statusCode).toBe(403);
  });
  it.each(['createdAt', 'taskSubType', 'requestHash'] as const)(
    'rejects an altered %s instead of serving a different result',
    async (field) => {
      if (field === 'requestHash')
        task.result = {
          ...(task.result as object),
          requestHash: 'a'.repeat(64),
        };
      else if (field === 'createdAt')
        task.createdAt = new Date(Date.parse(task.createdAt) + 1).toISOString();
      else task.taskSubType = 'parent-asin-query';
      expect((await get()).statusCode).toBe(404);
    },
  );
  it('returns missing or expired results as 404 without leaking internal details', async () => {
    f.receipts.clear();
    const response = await get();
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain(operation.operationKey);
  });
  it('never opens a receipt for a cancelled task or unfinished download', async () => {
    task.status = 'cancelled';
    expect((await get()).json().data.status).toBe('cancelled');
    expect((await get('/download')).statusCode).toBe(409);
    expect(f.unit.readReceipt).not.toHaveBeenCalled();
  });
  it('uses queue fallback only for the same independently verified owner and creation instance', async () => {
    f.tasks.clear();
    vi.mocked(f.port.findJob).mockResolvedValue({
      ...task,
    });
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(hash(JSON.stringify(response.json().data.result))).toBe(
      hash(JSON.stringify(publicFull)),
    );
    vi.mocked(f.port.findJob).mockResolvedValue({
      ...task,
      userId: 'other-owner',
    });
    expect((await get()).statusCode).toBe(403);
  });
  it.each([
    { createdAt: '2026-01-01T00:00:00.000Z' },
    { taskSubType: 'parent-asin-query' },
  ])(
    'rejects a different queued task incarnation before marking metadata completed',
    async (patch) => {
      task.status = 'processing';
      task.result = null;
      vi.mocked(f.port.findJob).mockResolvedValue({
        ...task,
        ...patch,
        status: 'completed',
        result: variantCheckResultReference(operation),
      });
      expect((await get()).statusCode).toBe(500);
      expect(f.port.store.mutate).not.toHaveBeenCalled();
      expect(f.tasks.get(task.taskId)?.status).toBe('processing');
    },
  );
  it('sanitizes a deeply nested complete payload without dropping valid data at depth 20', async () => {
    const result = { ...checkView, raw: {} as Record<string, unknown> };
    let cursor = result.raw;
    for (let i = 0; i < 50; i++) {
      cursor.child = { token: 'private-fixture' };
      cursor = cursor.child as Record<string, unknown>;
    }
    cursor.value = 'preserved terminal';
    f.receipts.set(operation.operationKey, { operation, result });
    const response = await get();
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain('private-fixture');
    expect(response.body).toContain('preserved terminal');
  });
  it('keeps only two complete database reads active', async () => {
    let resolve!: (value: unknown) => void;
    const gate = new Promise<unknown>((yes) => {
      resolve = yes;
    });
    f.unit.readReceipt.mockImplementation(() => gate);
    const first = get(),
      second = get();
    // LightMyRequest starts injection on the first then, just like awaiting it.
    const requests = Promise.all([first, second]);
    for (let i = 0; i < 100 && f.unit.readReceipt.mock.calls.length < 2; i++)
      await new Promise((yes) => setTimeout(yes, 1));
    expect(f.unit.readReceipt).toHaveBeenCalledTimes(2);
    expect((await get()).statusCode).toBe(429);
    resolve(checkView);
    expect((await requests).map((response) => response.statusCode)).toEqual([
      200, 200,
    ]);
  });
  it.each(['processing', 'failed'] as const)(
    'recovers %s metadata from an exhausted queue attempt and the exact saved receipt',
    async (status) => {
      task.status = status;
      task.result = null;
      vi.mocked(f.port.findJob).mockResolvedValue({
        ...task,
        status: 'failed',
        checkOperation: operation,
      });
      const response = await get();
      expect(response.statusCode).toBe(200);
      expect(response.json().data.status).toBe('completed');
      expect(hash(JSON.stringify(response.json().data.result))).toBe(
        hash(JSON.stringify(publicFull)),
      );
      expect(f.unit.readReceipt).toHaveBeenCalledTimes(1);
      expect(f.unit.readReceipt).toHaveBeenCalledWith(operation, true);
      expect(f.tasks.get(task.taskId)).toMatchObject({
        status: 'completed',
        result: variantCheckResultReference(operation),
      });
      expect((await get('/download')).statusCode).toBe(200);
    },
  );
  it('recovers a receipt that becomes visible after a failed queue reconciliation', async () => {
    task.status = 'processing';
    task.result = null;
    vi.mocked(f.port.findJob).mockResolvedValue({
      ...task,
      status: 'failed',
      checkOperation: operation,
    });
    f.receipts.clear();
    expect((await get()).json().data.status).toBe('failed');
    f.receipts.set(operation.operationKey, { operation, result: full });
    expect((await get()).json().data.status).toBe('completed');
  });
  it('requires the original queued request digest during recovery', async () => {
    task.status = 'failed';
    task.result = null;
    const changed = parseVariantCheckJob({
      ...data,
      params: { asinId: 'different', forceRefresh: true },
    });
    vi.mocked(f.port.findJob).mockResolvedValue({
      ...task,
      checkOperation: variantCheckJobOperation(changed),
    });
    expect((await get()).statusCode).toBe(404);
    expect(f.port.store.mutate).not.toHaveBeenCalled();
  });
  it('never mutates completion after current permission is revoked', async () => {
    task.status = 'failed';
    task.result = null;
    vi.mocked(f.port.findJob).mockResolvedValue({
      ...task,
      checkOperation: operation,
    });
    f.permissions.splice(0);
    expect((await get()).statusCode).toBe(403);
    expect(f.port.store.mutate).not.toHaveBeenCalled();
  });
  it('preserves a cancellation racing with the receipt read and does not reveal its payload', async () => {
    task.status = 'processing';
    task.result = null;
    vi.mocked(f.port.findJob).mockResolvedValue({
      ...task,
      status: 'failed',
      checkOperation: operation,
    });
    f.unit.readReceipt.mockImplementation(async () => {
      task.status = 'cancelled';
      return JSON.parse(JSON.stringify(full));
    });
    const response = await get();
    expect(response.json().data.status).toBe('cancelled');
    expect(response.json().data.result).toBeNull();
  });
  it('recovers through an owned failed queue fallback without recreating expired metadata', async () => {
    f.tasks.clear();
    vi.mocked(f.port.findJob).mockResolvedValue({
      ...task,
      status: 'failed',
      result: null,
      checkOperation: operation,
    });
    const response = await get('/download');
    expect(response.statusCode).toBe(200);
    expect(hash(response.body)).toBe(hash(JSON.stringify(publicFull)));
    expect(f.port.store.mutate).not.toHaveBeenCalled();
    expect(f.tasks.size).toBe(0);
  });
  it('keeps recovered task lists compact and excludes the internal queued operation', async () => {
    task.status = 'failed';
    task.result = null;
    vi.mocked(f.port.findJob).mockResolvedValue({
      ...task,
      checkOperation: operation,
    });
    const response = await f.http.inject({
      method: 'GET',
      url: '/api/v1/tasks',
      headers: f.headers,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data[0].status).toBe('completed');
    expect(Buffer.byteLength(response.body)).toBeLessThan(5000);
    expect(response.body).not.toContain('checkOperation');
  });
});
