import {
  asinCheckResultSchema,
  batchCheckResultSchema,
  batchQueryParentAsinResultSchema,
  variantGroupCheckResultSchema,
} from '@asin-monitor/contracts';
import { VariantCheckError } from '@asin-monitor/db';
import { SpApiError } from '@asin-monitor/sp-api';
import { VariantCheckCommitUncertainError } from '@asin-monitor/variant-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkView, variantCheckApp } from './helpers/variant-check-app';

describe('four variant-check HTTP endpoints', () => {
  let f: Awaited<ReturnType<typeof variantCheckApp>>;
  beforeEach(async () => {
    f = await variantCheckApp();
  });
  afterEach(async () => {
    await f.app.close();
    vi.restoreAllMocks();
  });
  const post = (
    path: string,
    body: unknown = {},
    headers: Record<string, string> = f.headers,
  ) =>
    f.http.inject({
      method: 'POST',
      url: `/api/v1${path}`,
      payload: body as object,
      headers,
    });
  const group = '/variant-groups/g1/check',
    single = '/asins/a1/check',
    batch = '/variant-groups/batch-check',
    parent = '/variant-check/batch-query-parent-asin';
  it.each([group, single])(
    'preserves anonymous synchronous checks with HTTP 200 and no-store: %s',
    async (path) => {
      const response = await post(path, {}, {});
      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      (path === group
        ? variantGroupCheckResultSchema
        : asinCheckResultSchema
      ).parse(response.json());
      expect(f.producer.store.create).not.toHaveBeenCalled();
      expect(f.unit.lockOperator).not.toHaveBeenCalled();
    },
  );
  it.each([group, single])(
    'defaults authenticated checks to owned asynchronous submission: %s',
    async (path) => {
      const response = await post(path);
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toMatchObject({
        status: 'pending',
        taskType: path === group ? 'variant-group-check' : 'asin-check',
      });
      expect(f.producer.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: response.json().data.taskId,
          taskType: 'variant-check',
          userId: f.auth.user.id,
          params: expect.objectContaining({ forceRefresh: true }),
        }),
      );
      expect(f.pipeline.checkSingle).not.toHaveBeenCalled();
      expect(f.pipeline.checkGroup).not.toHaveBeenCalled();
    },
  );
  it.each([group, single])(
    'rejects ownerless explicit asynchronous checks: %s',
    async (path) => {
      expect((await post(path, { useAsync: 'yes' }, {})).statusCode).toBe(401);
      expect(f.producer.store.create).not.toHaveBeenCalled();
    },
  );
  it.each([batch, parent])('requires authentication on %s', async (path) => {
    expect((await post(path, {}, {})).statusCode).toBe(401);
    expect(f.repository.transaction).not.toHaveBeenCalled();
  });
  it.each(['false', '0', 'off', 'no', false, 0])(
    'body useAsync=%s takes precedence over a true query flag',
    async (flag) => {
      const response = await post(`${single}?useAsync=true`, {
        useAsync: flag,
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data).toEqual(checkView);
      expect(f.producer.enqueue).not.toHaveBeenCalled();
    },
  );
  it('falls back to query then authentication when a mode flag is unrecognized', async () => {
    expect(
      (await post(`${single}?useAsync=false`, { useAsync: 'unknown' })).json()
        .data,
    ).toEqual(checkView);
    expect(
      (await post(single, { useAsync: 'unknown' })).json().data.status,
    ).toBe('pending');
  });
  it.each([
    ['', {}, true],
    ['?forceRefresh=false', {}, false],
    ['', { forceRefresh: false }, false],
    ['?forceRefresh=FALSE', {}, true],
    ['', { forceRefresh: 'false' }, true],
  ] as const)(
    'retains Legacy forceRefresh comparison %s / %j',
    async (query, body, expected) => {
      expect((await post(`${single}${query}`, body, {})).statusCode).toBe(200);
      expect(f.pipeline.checkSingle).toHaveBeenCalledWith(
        'a1',
        expect.objectContaining({ forceRefresh: expected }),
      );
    },
  );
  it('uses synchronous batch concurrency and retains the frozen complete result', async () => {
    const response = await post(batch, {
      groupIds: ['g1', 'g2'],
      forceRefresh: false,
      useAsync: false,
    });
    expect(response.statusCode).toBe(200);
    batchCheckResultSchema.parse(response.json());
    expect(f.executor.checkGroups).toHaveBeenCalledWith(
      ['g1', 'g2'],
      expect.objectContaining({ forceRefresh: false }),
      3,
    );
    expect(
      response.json().data.results[0].details.results[0].variantView.raw,
    ).toEqual(checkView.raw);
  });
  it('forces batches above twenty groups asynchronous despite useAsync false', async () => {
    const ids = Array.from({ length: 21 }, (_, index) => `g${index}`);
    const response = await post(batch, {
      groupIds: ids,
      useAsync: false,
      country: 'US',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      status: 'pending',
      total: 21,
    });
    expect(f.producer.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        taskType: 'batch-check',
        taskSubType: 'variant-group',
        params: { groupIds: ids, country: 'US', forceRefresh: true },
      }),
    );
  });
  it('normalizes parent ASINs and country, preserving complete synchronous items', async () => {
    const response = await post(parent, {
      asins: [' b000000001 '],
      country: 'us',
      useAsync: false,
    });
    expect(response.statusCode).toBe(200);
    batchQueryParentAsinResultSchema.parse(response.json());
    expect(f.parents.query).toHaveBeenCalledWith(
      ['B000000001'],
      'US',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(
      f.unit.operatorPermissionCodes.mock.calls.length,
    ).toBeGreaterThanOrEqual(3);
  });
  it.each([group, single, batch, parent])(
    'denies current permission loss before accepting or running %s',
    async (path) => {
      f.permissions.splice(0);
      const response = await post(path, {
        groupIds: ['g1'],
        asins: ['B000000001'],
        country: 'US',
      });
      expect(response.statusCode).toBe(403);
      expect(f.producer.store.create).not.toHaveBeenCalled();
      expect(f.pipeline.checkGroup).not.toHaveBeenCalled();
    },
  );
  it('does not downgrade an invalid credential to anonymous access', async () => {
    expect(
      (await post(group, {}, { authorization: 'Bearer invalid-fixture' }))
        .statusCode,
    ).toBe(403);
    expect(f.pipeline.checkGroup).not.toHaveBeenCalled();
  });
  it('rejects a foreign browser origin before submission or database work', async () => {
    expect(
      (
        await post(
          single,
          {},
          { ...f.headers, origin: 'https://foreign-fixture.example' },
        )
      ).statusCode,
    ).toBe(403);
    expect(f.producer.store.create).not.toHaveBeenCalled();
    expect(f.repository.transaction).not.toHaveBeenCalled();
  });
  it('observes permissions revoked after initial HTTP authorization', async () => {
    f.pipeline.checkSingle.mockImplementation(async (_id, context) => {
      f.permissions.splice(0);
      await context.authorize(f.unit as never);
      return checkView;
    });
    expect((await post(single, { useAsync: false })).statusCode).toBe(403);
  });
  it.each([
    [batch, { groupIds: [] }],
    [batch, { groupIds: ['x'.repeat(101)] }],
    [batch, { groupIds: Array.from({ length: 1001 }, () => 'g1') }],
    [parent, { asins: ['invalid'], country: 'US' }],
    [parent, { asins: ['B000000001'], country: 'invalid' }],
    [parent, { asins: [] }],
  ])('rejects invalid input before enqueuing: %s (#%#)', async (path, body) => {
    expect((await post(path as string, body)).statusCode).toBe(400);
    expect(f.producer.store.create).not.toHaveBeenCalled();
  });
  it('returns a stable task lookup ID when enqueue acknowledgement is uncertain', async () => {
    f.producer.enqueue.mockRejectedValue(
      new Error('private fixture Redis payload'),
    );
    const response = await post(single);
    expect(response.statusCode).toBe(500);
    expect(response.json().data).toMatchObject({
      status: 'unknown',
      taskId: expect.any(String),
    });
    expect(f.tasks.has(response.json().data.taskId)).toBe(true);
    expect(response.body).not.toContain('private fixture');
    expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain(
      'private fixture',
    );
  });
  it.each([
    [new VariantCheckError('capacity'), 429],
    [new VariantCheckError('asin-not-found'), 500],
    [new VariantCheckCommitUncertainError(), 500],
    [new SpApiError('HTTP_ERROR', 500), 500],
    [new Error('private fixture payload'), 500],
  ] as const)(
    'maps a failure without raw payload exposure',
    async (error, status) => {
      f.pipeline.checkSingle.mockRejectedValue(error);
      const response = await post(single, {}, {});
      expect(response.statusCode).toBe(status);
      expect(response.body).not.toContain('private fixture');
    },
  );
  it('requires PostgreSQL authority even for the anonymous compatibility routes', async () => {
    await f.app.close();
    f = await variantCheckApp({
      AUTH_DATA_AUTHORITY: 'legacy-mysql',
      DB_HOST: '127.0.0.1',
      DB_USER: 'fixture',
      DB_PASSWORD: 'fixture-password',
      DB_NAME: 'fixture',
    });
    expect((await post(single, {}, {})).statusCode).toBe(503);
    expect(f.pipeline.checkSingle).not.toHaveBeenCalled();
  });
});
