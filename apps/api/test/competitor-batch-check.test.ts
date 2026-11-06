import { competitorBatchCheckResultSchema } from '@asin-monitor/contracts';
import { VariantCheckError } from '@asin-monitor/db';
import {
  variantCheckJobOperation,
  variantCheckResultReference,
} from '@asin-monitor/variant-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { legacyCompetitorBatch } from './helpers/competitor-batch-legacy';
import { competitorCheckApp } from './helpers/competitor-check-app';

describe('competitor batch check HTTP and owned result boundary', () => {
  let f: Awaited<ReturnType<typeof competitorCheckApp>>;
  beforeEach(async () => {
    f = await competitorCheckApp();
  });
  afterEach(async () => {
    await f.app.close();
    vi.restoreAllMocks();
  });
  const path = '/api/v1/competitor/variant-groups/batch-check';
  const post = (body: object, headers = f.headers, suffix = '') =>
    f.http.inject({
      method: 'POST',
      url: path + suffix,
      payload: body,
      headers,
    });
  const get = (id: string, suffix = '') =>
    f.http.inject({
      method: 'GET',
      url: `/api/v1/tasks/${id}${suffix}`,
      headers: f.headers,
    });

  it('requires a live authorized session before work', async () => {
    expect(
      (await post({ groupIds: ['cg1'] }, {} as typeof f.headers)).statusCode,
    ).toBe(401);
    f.permissions.splice(0);
    expect((await post({ groupIds: ['cg1'] })).statusCode).toBe(403);
    expect(f.producer.store.create).not.toHaveBeenCalled();
    expect(f.pipeline.checkGroup).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { groupIds: [] },
    { groupIds: ['invalid\u0001'] },
    { groupIds: ['x'.repeat(51)] },
    { groupIds: new Array(1001).fill('cg1') },
  ])(
    'rejects malformed or oversized inputs before admission: %j',
    async (body) => {
      expect((await post(body)).statusCode).toBe(400);
      expect(f.producer.store.create).not.toHaveBeenCalled();
      expect(f.pipeline.checkGroup).not.toHaveBeenCalled();
    },
  );
  it('defaults to async with exact ordered duplicated literal inputs and no group preflight', async () => {
    const ids = [' cg1 ', '   ', '.', '😺'.repeat(50), ' cg1 '];
    const response = await post({ groupIds: ids, country: 'zz' });
    expect(response.statusCode).toBe(200);
    competitorBatchCheckResultSchema.parse(response.json());
    expect(response.json().data).toMatchObject({
      status: 'pending',
      total: ids.length,
    });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(f.unit.loadGroup).not.toHaveBeenCalled();
    expect(f.pipeline.checkGroup).not.toHaveBeenCalled();
    expect(f.producer.store.create.mock.calls[0]?.[1]).toBeTypeOf('function');
    expect(f.enqueued.get(response.json().data.taskId)).toMatchObject({
      taskType: 'batch-check',
      taskSubType: 'competitor-variant-group',
      params: { groupIds: ids, forceRefresh: true, country: 'zz' },
    });
  });
  it('runs explicit sync at concurrency three and retains missing groups as failures in their original positions', async () => {
    const original = f.pipeline.checkGroup.getMockImplementation()!;
    f.pipeline.checkGroup.mockImplementation(async (id, context) => {
      if (id === 'missing') throw new VariantCheckError('group-not-found');
      return original(id, context);
    });
    const run = vi.spyOn(f.batch, 'checkGroups');
    const response = await post({
      groupIds: ['cg1', 'missing', 'cg1'],
      useAsync: false,
      forceRefresh: false,
    });
    expect(response.statusCode).toBe(200);
    competitorBatchCheckResultSchema.parse(response.json());
    expect(response.json().data).toMatchObject({
      total: 3,
      results: [
        { groupId: 'cg1', success: true },
        { groupId: 'missing', success: false },
        { groupId: 'cg1', success: true },
      ],
    });
    expect(run).toHaveBeenCalledWith(
      ['cg1', 'missing', 'cg1'],
      expect.objectContaining({ forceRefresh: false }),
      3,
    );
    expect(f.producer.store.create).not.toHaveBeenCalled();
  });
  it('forces more than twenty groups async despite an explicit sync flag', async () => {
    const response = await post({
      groupIds: Array(21).fill('cg1'),
      useAsync: false,
      forceRefresh: false,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      status: 'pending',
      total: 21,
    });
    expect(f.pipeline.checkGroup).not.toHaveBeenCalled();
    expect(f.enqueued.get(response.json().data.taskId)?.params).toMatchObject({
      forceRefresh: false,
    });
  });
  it('supports the shared query async flag while retaining the Legacy forceRefresh default', async () => {
    const response = await post(
      { groupIds: ['cg1'] },
      f.headers,
      '?useAsync=false',
    );
    expect(response.statusCode).toBe(200);
    expect(response.json().data.total).toBe(1);
    expect(f.pipeline.checkGroup).toHaveBeenCalledWith(
      'cg1',
      expect.objectContaining({ forceRefresh: true }),
    );
    expect(f.producer.store.create).not.toHaveBeenCalled();
  });

  it('matches the actual Legacy controller envelope, default async and ordered sync failure behavior', async () => {
    const ids = ['cg1', 'missing', 'cg1'];
    const original = f.pipeline.checkGroup.getMockImplementation()!;
    f.pipeline.checkGroup.mockImplementation(async (id, scope) => {
      if (id === 'missing') throw new VariantCheckError('group-not-found');
      return original(id, scope);
    });
    const neo = await post({ groupIds: ids, useAsync: false });
    const values = neo.json().data.results as Array<Record<string, unknown>>;
    const legacy = await legacyCompetitorBatch(
      { groupIds: ids, useAsync: false },
      async (id) => {
        if (id === 'missing') throw new Error('变体组不存在');
        const {
          groupId: _id,
          success: _success,
          ...value
        } = values.find((row) => row.groupId === id)!;
        return value;
      },
    );
    expect(neo.statusCode).toBe(legacy.statusCode);
    expect(neo.json()).toEqual(legacy.response);
    const asyncLegacy = await legacyCompetitorBatch(
      { groupIds: ids },
      async () => {
        throw new Error('must not check synchronously');
      },
    );
    expect(asyncLegacy.response.data).toMatchObject({
      status: 'pending',
      total: 3,
    });
    expect(asyncLegacy.enqueued).toHaveLength(1);
    expect((await post({ groupIds: ids })).json().data).toMatchObject({
      status: 'pending',
      total: 3,
    });
  });
  it('returns a stable unknown task identity after a lost enqueue acknowledgement', async () => {
    f.producer.enqueue.mockRejectedValue(
      new Error('private Redis transport payload'),
    );
    const response = await post({ groupIds: ['cg1'] });
    expect(response.statusCode).toBe(500);
    expect(response.json().data).toMatchObject({
      taskId: expect.any(String),
      status: 'unknown',
    });
    expect(response.body).not.toContain('private Redis');
  });
  it('reads and downloads only the owned competitor-batch receipt, then respects current permission revocation', async () => {
    const submitted = await post({ groupIds: ['cg1'] });
    const id = submitted.json().data.taskId as string;
    const task = f.tasks.get(id)!;
    const operation = variantCheckJobOperation(f.enqueued.get(id)!);
    expect(operation.resultKind).toBe('competitor-batch');
    task.status = 'completed';
    task.result = variantCheckResultReference(operation);
    f.receipts.set(operation.operationKey, {
      operation,
      result: {
        total: 1,
        results: [
          {
            groupId: 'cg1',
            success: true,
            details: { token: 'private', result: 'complete' },
          },
        ],
      },
    });
    const info = await get(id);
    expect(info.statusCode).toBe(200);
    expect(info.json().data.result).toMatchObject({
      results: [{ details: { result: 'complete' } }],
    });
    expect(info.body).not.toContain('private');
    const download = await get(id, '/download');
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toContain('application/json');
    expect(JSON.parse(download.body)).toEqual(info.json().data.result);
    f.permissions.splice(0);
    expect((await get(id, '/download')).statusCode).toBe(403);
  });
  it('denies a foreign owner and cancels a queued batch without executing its groups', async () => {
    const submitted = await post({ groupIds: ['cg1'] });
    const id = submitted.json().data.taskId as string;
    const task = f.tasks.get(id)!;
    const owner = task.userId;
    task.userId = 'foreign';
    expect((await get(id)).statusCode).toBe(403);
    task.userId = owner;
    const cancelled = await f.http.inject({
      method: 'POST',
      url: `/api/v1/tasks/${id}/cancel`,
      headers: f.headers,
      payload: {},
    });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().data.status).toBe('cancelled');
    expect(f.enqueued.has(id)).toBe(false);
    expect((await get(id, '/download')).statusCode).toBe(409);
    expect(f.pipeline.checkGroup).not.toHaveBeenCalled();
  });
});
