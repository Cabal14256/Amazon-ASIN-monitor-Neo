import { batchDeleteVariantGroupsResultSchema } from '@asin-monitor/contracts';
import {
  AsinBatchDeleteRepositoryError,
  batchDeleteSyncResult,
  buildBatchDeleteAnalysis,
  type AsinBatchDeleteRepositoryPort,
  type AsinBatchDeleteUnit,
} from '@asin-monitor/db';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ASIN_BATCH_DELETE_REPOSITORY } from '../src/asin/asin-batch-delete.service';
import { AsinModule } from '../src/asin/asin.module';
import { TaskQueryRuntime } from '../src/tasks/task-query.runtime';
import { sessionApp } from './helpers/session-app';
import {
  taskAuthFixture,
  taskSessionId,
  taskUserId,
} from './helpers/task-query-fixtures';

describe('ASIN batch deletion HTTP acceptance', () => {
  let app: Awaited<ReturnType<typeof sessionApp>>;
  let headers: Record<string, string>;
  let auth: ReturnType<typeof taskAuthFixture>;
  const analysis = buildBatchDeleteAnalysis(
    { groupIds: ['g'], asinIds: ['missing'] },
    ['g'],
    [],
    2,
  );
  let unit: ReturnType<typeof makeUnit>;
  function makeUnit() {
    return {
      lockOperator: vi.fn(async () => auth.user),
      lockSession: vi.fn(async () => auth.session),
      operatorPermissionCodes: vi.fn(async () => ['asin:delete']),
      analyze: vi.fn(async () => analysis),
      execute: vi.fn(async () => batchDeleteSyncResult(analysis)),
    };
  }
  let transaction: ReturnType<typeof vi.fn>;
  const create = vi.fn(async (input: Record<string, unknown>) => ({
    ...input,
    createdAt: '2026-09-01T00:00:00.000Z',
  }));
  const enqueue = vi.fn(async () => undefined);
  const openBatchDelete = vi.fn(() => ({ store: { create }, enqueue }));
  beforeEach(async () => {
    vi.clearAllMocks();
    create.mockImplementation(async (input) => ({
      ...input,
      createdAt: '2026-09-01T00:00:00.000Z',
    }));
    enqueue.mockResolvedValue(undefined);
    auth = taskAuthFixture();
    auth.repository.getPermissionCodes.mockResolvedValue([
      'asin:delete',
    ] as never);
    unit = makeUnit();
    const repository: AsinBatchDeleteRepositoryPort = {
      transaction: vi.fn(async (operation) =>
        operation(unit as unknown as AsinBatchDeleteUnit),
      ),
    };
    transaction = repository.transaction as ReturnType<typeof vi.fn>;
    app = await sessionApp(
      auth.repository,
      {},
      (builder) =>
        builder
          .overrideProvider(ASIN_BATCH_DELETE_REPOSITORY)
          .useValue(repository)
          .overrideProvider(TaskQueryRuntime)
          .useValue({ openBatchDelete }),
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
    vi.restoreAllMocks();
  });
  const request = (
    body: Record<string, unknown> = {
      groupIds: [' g ', 'g'],
      asinIds: ['missing'],
    },
    authHeaders = headers,
  ) =>
    app.http.inject({
      method: 'POST',
      url: '/api/v1/variant-groups/batch-delete',
      headers: authHeaders,
      payload: body,
    });
  it('returns the exact synchronous envelope and never opens Redis', async () => {
    const response = await request();
    expect(response.statusCode).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    batchDeleteVariantGroupsResultSchema.parse(response.json());
    expect(response.json()).toEqual({
      success: true,
      errorCode: 0,
      data: batchDeleteSyncResult(analysis),
    });
    expect(unit.execute).toHaveBeenCalledWith({
      groupIds: ['g'],
      asinIds: ['missing'],
    });
    expect(openBatchDelete).not.toHaveBeenCalled();
  });
  it('enqueues canonical targets with the registry timestamp and returns the same UUID', async () => {
    const response = await request({
      groupIds: ['g'],
      asinIds: ['missing'],
      useAsync: ' YES ',
    });
    expect(response.statusCode).toBe(200);
    batchDeleteVariantGroupsResultSchema.parse(response.json());
    const data = response.json().data;
    expect(data).toEqual({
      mode: 'async',
      taskId: expect.any(String),
      status: 'pending',
      totalRequested: 2,
      estimatedAsinCount: 2,
    });
    expect(enqueue).toHaveBeenCalledWith({
      taskId: data.taskId,
      userId: taskUserId,
      createdAt: '2026-09-01T00:00:00.000Z',
      taskType: 'batch-delete',
      taskSubType: 'variant-group-delete',
      title: '批量删除变体组',
      domain: 'asin',
      groupIds: ['g'],
      asinIds: ['missing'],
    });
    expect(unit.execute).not.toHaveBeenCalled();
  });
  it('automatically uses the asynchronous path for a large nested group', async () => {
    unit.analyze.mockResolvedValue({ ...analysis, estimatedAsinCount: 501 });
    expect((await request()).json().data.mode).toBe('async');
    expect(enqueue).toHaveBeenCalledOnce();
  });
  it('explicit synchronous mode overrides automatic thresholds', async () => {
    unit.analyze.mockResolvedValue({ ...analysis, estimatedAsinCount: 501 });
    expect(
      (await request({ groupIds: ['g'], useAsync: 'off' })).json().data.mode,
    ).toBe('sync');
    expect(enqueue).not.toHaveBeenCalled();
  });
  it.each([
    {},
    { groupIds: [] },
    { groupIds: ['g'], unexpected: true },
    { groupIds: ['x'.repeat(51)] },
  ])('rejects malformed targets %j', async (body) => {
    expect((await request(body)).statusCode).toBe(400);
    expect(unit.analyze).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });
  it('bounds raw duplicate entries before normalization', async () => {
    expect(
      (await request({ groupIds: Array(1001).fill('g') })).statusCode,
    ).toBe(413);
    expect(unit.analyze).not.toHaveBeenCalled();
  });
  it.each(['missing-login', 'permission', 'origin'] as const)(
    'rejects %s before database acceptance',
    async (kind) => {
      if (kind === 'permission')
        auth.repository.getPermissionCodes.mockResolvedValue([]);
      const response = await request(
        undefined,
        kind === 'missing-login'
          ? {}
          : kind === 'origin'
          ? { ...headers, origin: 'https://foreign.invalid' }
          : headers,
      );
      expect(response.statusCode).toBe(kind === 'missing-login' ? 401 : 403);
      expect(transaction).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    },
  );
  it.each(['permission', 'session', 'account', 'password'] as const)(
    'rechecks current %s inside the transaction',
    async (kind) => {
      if (kind === 'permission')
        unit.operatorPermissionCodes.mockResolvedValue([]);
      if (kind === 'session')
        unit.lockSession.mockResolvedValue({
          ...auth.session,
          status: 'REVOKED',
        });
      if (kind === 'account')
        unit.lockOperator.mockResolvedValue({
          ...auth.user,
          status: 'DISABLED',
        });
      if (kind === 'password')
        unit.lockOperator.mockResolvedValue({
          ...auth.user,
          forcePasswordChange: true,
        });
      expect(
        (await request({ groupIds: ['g'], useAsync: true })).statusCode,
      ).toBe(403);
      expect(unit.analyze).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    },
  );
  it.each(['create', 'enqueue'] as const)(
    'returns lookup identity for an uncertain %s acknowledgement',
    async (phase) => {
      (phase === 'create' ? create : enqueue).mockRejectedValueOnce(
        new Error('private password=secret99'),
      );
      const response = await request({ groupIds: ['g'], useAsync: true });
      expect(response.statusCode).toBe(500);
      expect(response.json().data).toEqual({
        taskId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        status: 'unknown',
      });
      expect(JSON.stringify([response.json(), app.logger])).not.toContain(
        'secret99',
      );
      expect(create).toHaveBeenCalledOnce();
      expect(enqueue).toHaveBeenCalledTimes(phase === 'create' ? 0 : 1);
      expect(unit.execute).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['capacity', 429],
    ['parent-changed', 409],
    ['delete-mismatch', 500],
  ] as const)('maps repository %s safely', async (code, status) => {
    unit.execute.mockRejectedValueOnce(
      new AsinBatchDeleteRepositoryError(code),
    );
    expect((await request()).statusCode).toBe(status);
  });
});
