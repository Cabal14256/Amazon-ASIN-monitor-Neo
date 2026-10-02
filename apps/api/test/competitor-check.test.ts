import {
  competitorCheckResultSchema,
  taskInfoResultSchema,
} from '@asin-monitor/contracts';
import { VariantCheckError } from '@asin-monitor/db';
import {
  variantCheckJobOperation,
  variantCheckResultReference,
} from '@asin-monitor/variant-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { competitorCheckApp } from './helpers/competitor-check-app';

describe('competitor immediate check HTTP', () => {
  let f: Awaited<ReturnType<typeof competitorCheckApp>>;
  beforeEach(async () => {
    f = await competitorCheckApp();
  });
  afterEach(async () => {
    await f.app.close();
    vi.restoreAllMocks();
  });
  const post = (
    path: string,
    body: unknown = { useAsync: true },
    headers: Record<string, string> = f.headers,
  ) =>
    f.http.inject({
      method: 'POST',
      url: `/api/v1${path}`,
      payload: body as object,
      headers,
    });
  const single = `/competitor/asins/${'ca1'}/check`;
  const group = `/competitor/variant-groups/${'cg1'}/check`;
  const getTask = (
    id: string,
    suffix = '',
    headers: Record<string, string> = f.headers,
  ) =>
    f.http.inject({
      method: 'GET',
      url: `/api/v1/tasks/${id}${suffix}`,
      headers,
    });
  const cancelTask = (
    id: string,
    headers: Record<string, string> = f.headers,
  ) => post(`/tasks/${id}/cancel`, {}, headers);

  it.each([single, group])('requires authentication on %s', async (path) => {
    expect((await post(path, {}, {})).statusCode).toBe(401);
    expect(f.repository.transaction).not.toHaveBeenCalled();
  });

  it.each([single, group])(
    'creates a durable async task when explicitly requested: %s',
    async (path) => {
      const response = await post(path);
      expect(response.statusCode).toBe(200);
      expect(competitorCheckResultSchema.parse(response.json()).data).toEqual(
        response.json().data,
      );
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json().data).toMatchObject({
        status: 'pending',
        taskType:
          path === single
            ? 'competitor-asin-check'
            : 'competitor-variant-group-check',
      });
      expect(f.producer.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          taskType: 'variant-check',
          taskSubType:
            path === single
              ? 'competitor-asin-check'
              : 'competitor-variant-group-check',
          params: expect.objectContaining({ forceRefresh: true }),
        }),
      );
      expect(f.pipeline.checkSingle).not.toHaveBeenCalled();
      expect(f.pipeline.checkGroup).not.toHaveBeenCalled();
    },
  );

  it.each([single, group])(
    'returns an owned pending task after explicit enqueue: %s',
    async (path) => {
      const submitted = await post(path);
      expect(submitted.statusCode).toBe(200);
      const id = submitted.json().data.taskId as string;
      const response = await getTask(id);
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      taskInfoResultSchema.parse(response.json());
      expect(response.json().data).toMatchObject({
        taskId: id,
        taskType: 'variant-check',
        taskSubType:
          path === single
            ? 'competitor-asin-check'
            : 'competitor-variant-group-check',
        status: 'pending',
        result: null,
      });
      expect(f.enqueued.has(id)).toBe(true);
      expect(f.unit.readReceipt).not.toHaveBeenCalled();
      expect(f.pipeline.checkSingle).not.toHaveBeenCalled();
      expect(f.pipeline.checkGroup).not.toHaveBeenCalled();
    },
  );

  it.each([single, group])(
    'reads a completed owned competitor receipt through task detail and download: %s',
    async (path) => {
      const submitted = await post(path);
      const id = submitted.json().data.taskId as string;
      const data = f.enqueued.get(id)!;
      const operation = variantCheckJobOperation(data);
      const result =
        path === single
          ? {
              isBroken: false,
              details: {
                asin: 'B000000001',
                result: { title: 'Complete competitor result' },
                authorization: 'private-fixture-token',
              },
            }
          : {
              isBroken: false,
              brokenASINs: [],
              details: { totalASINs: 1, results: [{ asin: 'B000000001' }] },
              token: 'private-fixture-token',
            };
      const task = f.tasks.get(id)!;
      task.status = 'completed';
      task.result = variantCheckResultReference(operation);
      f.receipts.set(operation.operationKey, { operation, result });
      vi.mocked(f.repository.transaction).mockClear();
      const response = await getTask(id);
      expect(response.statusCode).toBe(200);
      taskInfoResultSchema.parse(response.json());
      expect(response.json().data.status).toBe('completed');
      expect(response.json().data.result).toMatchObject({ isBroken: false });
      expect(response.body).toContain('B000000001');
      expect(response.body).not.toContain('private-fixture-token');
      expect(f.repository.transaction).toHaveBeenCalledOnce();
      expect(f.unit.readReceipt).toHaveBeenCalledWith(operation, false);
      const download = await getTask(id, '/download');
      expect(download.statusCode).toBe(200);
      expect(download.headers['cache-control']).toBe('no-store');
      expect(download.headers['content-type']).toContain('application/json');
      expect(download.body).not.toContain('private-fixture-token');
      expect(JSON.parse(download.body)).toEqual(response.json().data.result);
      expect(f.unit.readReceipt).toHaveBeenCalledTimes(2);
    },
  );

  it('denies another task owner before receipt lookup or queue cancellation', async () => {
    const submitted = await post(single);
    const id = submitted.json().data.taskId as string;
    f.tasks.get(id)!.userId = 'different-owner';
    expect((await getTask(id)).statusCode).toBe(403);
    expect((await cancelTask(id)).statusCode).toBe(403);
    expect(f.unit.readReceipt).not.toHaveBeenCalled();
    expect(f.cancellationPort.cancelJob).not.toHaveBeenCalled();
    expect(f.enqueued.has(id)).toBe(true);
  });

  it('rejects a revoked session for task lookup and cancellation', async () => {
    const submitted = await post(single);
    const id = submitted.json().data.taskId as string;
    f.auth.session.status = 'REVOKED';
    expect((await getTask(id)).statusCode).toBe(403);
    expect((await cancelTask(id)).statusCode).toBe(403);
    expect(f.unit.readReceipt).not.toHaveBeenCalled();
    expect(f.cancellationPort.cancelJob).not.toHaveBeenCalled();
  });

  it('checks current asin permission before reading a completed competitor receipt', async () => {
    const submitted = await post(single);
    const id = submitted.json().data.taskId as string;
    const task = f.tasks.get(id)!;
    const operation = variantCheckJobOperation(f.enqueued.get(id)!);
    task.status = 'completed';
    task.result = variantCheckResultReference(operation);
    f.receipts.set(operation.operationKey, {
      operation,
      result: { isBroken: false, details: { asin: 'B000000001' } },
    });
    f.permissions.splice(0);
    expect((await getTask(id)).statusCode).toBe(403);
    expect((await getTask(id, '/download')).statusCode).toBe(403);
    expect(f.unit.readReceipt).not.toHaveBeenCalled();
  });

  it('removes a pending competitor job before execution and keeps it cancelled', async () => {
    const submitted = await post(single);
    const id = submitted.json().data.taskId as string;
    expect(f.enqueued.has(id)).toBe(true);
    const cancelled = await cancelTask(id);
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.headers['cache-control']).toBe('no-store');
    expect(cancelled.json().data).toMatchObject({
      taskId: id,
      status: 'cancelled',
    });
    expect(f.cancellationPort.cancelJob).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: id, taskType: 'variant-check' }),
    );
    expect(f.enqueued.has(id)).toBe(false);
    expect((await getTask(id)).json().data.status).toBe('cancelled');
    expect((await getTask(id, '/download')).statusCode).toBe(409);
    expect(f.pipeline.checkSingle).not.toHaveBeenCalled();
    expect(f.pipeline.checkGroup).not.toHaveBeenCalled();
    expect(f.unit.readReceipt).not.toHaveBeenCalled();
  });

  it.each([single, group])(
    'keeps the active Legacy request synchronous when useAsync is omitted: %s',
    async (path) => {
      const response = await post(path, {});
      expect(response.statusCode).toBe(200);
      competitorCheckResultSchema.parse(response.json());
      expect(response.json().data).toMatchObject({ isBroken: false });
      expect(
        path === single ? f.pipeline.checkSingle : f.pipeline.checkGroup,
      ).toHaveBeenCalledWith(
        path === single ? 'ca1' : 'cg1',
        expect.objectContaining({ forceRefresh: true }),
      );
      expect(f.producer.store.create).not.toHaveBeenCalled();
      expect(f.producer.enqueue).not.toHaveBeenCalled();
    },
  );

  it.each([
    [`/competitor/asins/${'a'.repeat(101)}/check`, 414],
    [`/competitor/variant-groups/${'g'.repeat(101)}/check`, 414],
    ['/competitor/asins/invalid%01id/check', 400],
    ['/competitor/variant-groups/invalid%01id/check', 400],
  ] as const)(
    'rejects an invalid path identifier: %s',
    async (path, status) => {
      const response = await post(path);
      // Fastify bounds raw path parameters before the service sees them.
      expect(response.statusCode).toBe(status);
      if (status === 400) expect(response.json().errorCode).toBe(400);
      expect(f.repository.transaction).not.toHaveBeenCalled();
      expect(f.producer.store.create).not.toHaveBeenCalled();
      expect(f.producer.enqueue).not.toHaveBeenCalled();
    },
  );

  it.each([single, group])(
    'runs an explicit synchronous request through the shared pipeline: %s',
    async (path) => {
      const response = await post(path, {
        useAsync: false,
        forceRefresh: false,
      });
      expect(response.statusCode).toBe(200);
      competitorCheckResultSchema.parse(response.json());
      expect(response.json().data).toMatchObject({ isBroken: false });
      expect(
        path === single ? f.pipeline.checkSingle : f.pipeline.checkGroup,
      ).toHaveBeenCalledWith(
        path === single ? 'ca1' : 'cg1',
        expect.objectContaining({ forceRefresh: false }),
      );
      expect(f.producer.enqueue).not.toHaveBeenCalled();
    },
  );

  it('rechecks current permission before accepting a task', async () => {
    f.permissions.splice(0);
    expect((await post(single)).statusCode).toBe(403);
    expect(f.producer.store.create).not.toHaveBeenCalled();
  });

  it('rejects a foreign origin before opening the dual-database transaction', async () => {
    expect(
      (
        await post(
          single,
          {},
          { ...f.headers, origin: 'https://foreign.example' },
        )
      ).statusCode,
    ).toBe(403);
    expect(f.repository.transaction).not.toHaveBeenCalled();
  });

  it('maps missing competitor records without leaking repository errors', async () => {
    vi.mocked(f.unit.loadSingle).mockRejectedValue(
      new VariantCheckError('asin-not-found'),
    );
    const response = await post(single, { useAsync: false });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('asin-not-found');
  });

  it('preserves an unknown enqueue acknowledgement as a task lookup response', async () => {
    f.producer.enqueue.mockRejectedValue(new Error('private redis payload'));
    const response = await post(single);
    expect(response.statusCode).toBe(500);
    expect(response.json().data).toMatchObject({
      status: 'unknown',
      taskId: expect.any(String),
    });
    expect(response.body).not.toContain('private redis payload');
  });
});
