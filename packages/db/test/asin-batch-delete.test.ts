import { batchDeleteVariantGroupsResultSchema } from '@asin-monitor/contracts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  addBatchDeleteResult,
  batchDeleteSyncResult,
  batchDeleteTaskResult,
  buildBatchDeleteAnalysis,
  createBatchDeleteAggregate,
  DEFAULT_BATCH_DELETE_LIMITS,
  MAX_ASIN_BATCH_DELETE_TARGETS,
  normalizeBatchDeleteMode,
  parseBatchDeleteRequest,
  splitBatchDeletePlan,
  useAsyncBatchDelete,
  type BatchDeleteAnalysis,
  type BatchDeleteCounts,
  type BatchDeleteIds,
} from '../src/domain/asin-batch-delete';

type LegacyAggregate = ReturnType<typeof createBatchDeleteAggregate> & {
  mode: string;
};
function legacyFixture(
  options: {
    groups?: string[];
    asins?: { id: string; variantGroupId: string }[];
    env?: Record<string, string>;
  } = {},
) {
  const query = async (sql: string, params: string[] = []) => {
    if (sql.startsWith('SELECT id FROM'))
      return (options.groups ?? [])
        .filter((id) => params.includes(id))
        .map((id) => ({ id }));
    if (sql.startsWith('SELECT id, variant_group_id'))
      return (options.asins ?? [])
        .filter((row) => params.includes(row.id))
        .map((row) => ({ id: row.id, variant_group_id: row.variantGroupId }));
    if (sql.startsWith('SELECT COUNT(*)'))
      return [
        {
          total: (options.asins ?? []).filter((row) =>
            params.includes(row.variantGroupId),
          ).length,
        },
      ];
    if (sql.startsWith('DELETE FROM') || sql.startsWith('UPDATE '))
      return { affectedRows: 0 };
    throw new Error('Unexpected Legacy deletion fixture query');
  };
  const database = {
    query,
    withTransaction: (
      callback: (connection: { query: typeof query }) => Promise<unknown>,
    ) => callback({ query }),
  };
  function load(name: string) {
    const filename = resolve(
      __dirname,
      `../../../server/src/services/${name}.js`,
    );
    const module = { exports: {} };
    runInNewContext(
      readFileSync(filename, 'utf8'),
      {
        module,
        exports: module.exports,
        process: { env: options.env ?? {} },
        require: (dependency: string) => {
          if (
            dependency === '../config/database' ||
            dependency === '../config/competitor-database'
          )
            return database;
          if (
            dependency === '../models/VariantGroup' ||
            dependency === '../models/CompetitorVariantGroup'
          )
            return { clearCache() {} };
          if (dependency === '../utils/logger')
            return { info() {}, warn() {}, error() {} };
          if (dependency === 'uuid') return { v4: () => 'unused-fixture-id' };
          if (dependency === 'fs') return { promises: {} };
          if (dependency === 'path') return {};
          throw new Error('Unexpected Legacy deletion dependency');
        },
      },
      { filename },
    );
    return module.exports;
  }
  const service = load('batchDeleteService') as {
    normalizeIdList(raw: unknown): string[];
    normalizeUseAsync(raw: unknown): boolean | undefined;
    analyzeBatchDelete(
      input: BatchDeleteIds & { domain: 'asin' },
    ): Promise<BatchDeleteAnalysis>;
    executeBatchDelete(
      input: BatchDeleteIds & { domain: 'asin' },
    ): Promise<unknown>;
    shouldUseAsyncForBatchDelete(
      analysis: Pick<
        BatchDeleteAnalysis,
        'totalRequested' | 'estimatedAsinCount'
      >,
      mode?: unknown,
    ): boolean;
    splitPlanIntoChunks(
      analysis: Pick<BatchDeleteAnalysis, 'groupIds' | 'directAsinIds'>,
    ): BatchDeleteIds[];
    createEmptyAggregateResult(total: number): LegacyAggregate;
    addDeleteResult(target: LegacyAggregate, result: BatchDeleteCounts): void;
    finalizeAggregateResult(result: LegacyAggregate): unknown;
  };
  const result = load('taskResultService') as {
    normalizeBatchDeleteTaskResult(result: unknown): unknown;
  };
  return { service, result };
}
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
describe('batch deletion / actual Legacy domain compatibility', () => {
  it.each([
    {
      groupIds: [' g ', 'g', '', null, 0, false, 123, true],
      asinIds: ['a', ' a '],
    },
    { groupIds: 'ignored', asinIds: ['a'] },
    { groupIds: [['g'], { id: 'g' }], asinIds: null },
  ])(
    'retains scalar coercion, trimming, order and deduplication: %#',
    (raw) => {
      const { service } = legacyFixture();
      expect(parseBatchDeleteRequest(raw)).toEqual({
        groupIds: service.normalizeIdList(raw.groupIds),
        asinIds: service.normalizeIdList(raw.asinIds),
      });
    },
  );
  it.each([
    true,
    false,
    ' true ',
    'FALSE',
    '1',
    '0',
    'YeS',
    'no',
    'on',
    ' OFF ',
    '',
    'auto',
    1,
    0,
    null,
    undefined,
  ])('matches explicit asynchronous mode normalization: %s', (value) => {
    expect(normalizeBatchDeleteMode(value)).toBe(
      legacyFixture().service.normalizeUseAsync(value),
    );
  });
  it.each([
    { groupIds: ['missing-g', 'g1'], asinIds: ['a2', 'a1', 'missing-a'] },
    { groupIds: [], asinIds: ['a2', 'a1'] },
    { groupIds: ['g2', 'g1'], asinIds: ['a1', 'a2'] },
    { groupIds: ['missing-g'], asinIds: ['missing-a'] },
  ])(
    'compares the complete analysis and synchronous result: %#',
    async (request) => {
      const groups = ['g1', 'g2'];
      const asins = [
        { id: 'a1', variantGroupId: 'g1' },
        { id: 'a2', variantGroupId: 'g2' },
        { id: 'a3', variantGroupId: 'g1' },
      ];
      const { service } = legacyFixture({ groups, asins });
      const expected = await service.analyzeBatchDelete({
        ...request,
        domain: 'asin',
      });
      const actual = buildBatchDeleteAnalysis(
        request,
        groups.filter((id) => request.groupIds.includes(id)),
        asins.filter((row) => request.asinIds.includes(row.id)),
        asins.filter((row) => request.groupIds.includes(row.variantGroupId))
          .length,
      );
      expect(json(actual)).toEqual(json(expected));
      const response = batchDeleteSyncResult(actual);
      expect(json(response)).toEqual(
        json(await service.executeBatchDelete({ ...request, domain: 'asin' })),
      );
      batchDeleteVariantGroupsResultSchema.parse({
        success: true,
        errorCode: 0,
        data: response,
      });
    },
  );
  it.each([
    { totalRequested: 50, estimatedAsinCount: 500 },
    { totalRequested: 51, estimatedAsinCount: 5 },
    { totalRequested: 1, estimatedAsinCount: 501 },
    { totalRequested: 1000, estimatedAsinCount: 100000 },
  ])('preserves threshold boundaries and explicit override: %#', (analysis) => {
    const { service } = legacyFixture();
    for (const mode of [undefined, true, false])
      expect(
        useAsyncBatchDelete(analysis, mode, DEFAULT_BATCH_DELETE_LIMITS),
      ).toBe(service.shouldUseAsyncForBatchDelete(analysis, mode));
  });
  it('splits groups first, then direct ASINs with the configured chunk size', () => {
    const analysis = {
      groupIds: ['g3', 'g2', 'g1'],
      directAsinIds: ['a5', 'a4', 'a3', 'a2', 'a1'],
    };
    const { service } = legacyFixture({
      env: { BATCH_DELETE_CHUNK_SIZE: '2' },
    });
    expect(json(splitBatchDeletePlan(analysis, 2))).toEqual(
      json(service.splitPlanIntoChunks(analysis)),
    );
  });
  it.each([false, true])(
    'compares complete asynchronous totals, skipped IDs, failures and warnings (failure=%s)',
    (failed) => {
      const { service, result } = legacyFixture();
      const current = createBatchDeleteAggregate(12),
        previous = service.createEmptyAggregateResult(0);
      const chunks: BatchDeleteCounts[] = [
        {
          totalRequested: 4,
          deletedGroupCount: 1,
          deletedDirectAsinCount: 0,
          deletedNestedAsinCount: 30,
          skipped: { groupIds: ['missing-g'], asinIds: ['missing-a'] },
        },
        {
          totalRequested: 8,
          deletedGroupCount: 0,
          deletedDirectAsinCount: 5,
          deletedNestedAsinCount: 0,
          skipped: { groupIds: ['missing-g'], asinIds: ['missing-a2'] },
        },
      ];
      for (const chunk of chunks) {
        addBatchDeleteResult(current, chunk);
        service.addDeleteResult(previous, chunk);
      }
      if (failed) {
        const sample = {
          index: 2,
          groupCount: 0,
          asinCount: 3,
          error: '删除失败',
        };
        current.failedCount = previous.failedCount = 1;
        current.failedSamples.push(sample);
        previous.failedSamples.push(sample);
      }
      // The real Legacy Processor restores the original request total after all chunks.
      previous.totalRequested = 12;
      expect(json(batchDeleteTaskResult(current))).toEqual(
        json(
          result.normalizeBatchDeleteTaskResult(
            service.finalizeAggregateResult(previous),
          ),
        ),
      );
    },
  );
  it.each([
    null,
    [],
    {},
    { groupIds: [' ', null, 0] },
    { groupIds: ['x'], extra: true },
    { asinIds: [{ toString: 'invalid' }] },
    { asinIds: ['bad\0id'] },
    { asinIds: ['x'.repeat(51)] },
  ])('rejects invalid or unstorable input before querying: %#', (value) => {
    expect(() => parseBatchDeleteRequest(value)).toThrow();
  });
  it('bounds both raw lists together before allocating a task payload', () => {
    expect(() =>
      parseBatchDeleteRequest({
        groupIds: Array(MAX_ASIN_BATCH_DELETE_TARGETS).fill('g'),
        asinIds: ['a'],
      }),
    ).toThrow(expect.objectContaining({ code: 'capacity' }));
    expect(
      parseBatchDeleteRequest({
        groupIds: Array(MAX_ASIN_BATCH_DELETE_TARGETS).fill('g'),
      }),
    ).toEqual({ groupIds: ['g'], asinIds: [] });
  });
  it.each([0, -1, 0.5, 501, Infinity, NaN])(
    'rejects unsafe chunk sizes without entering a split loop: %s',
    (size) => {
      expect(() =>
        splitBatchDeletePlan({ groupIds: ['g'], directAsinIds: [] }, size),
      ).toThrow();
    },
  );
});
