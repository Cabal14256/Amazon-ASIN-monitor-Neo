import { describe, expect, it } from 'vitest';
import { VariantCheckError } from '../src/domain/variant-check';
import {
  assertVariantCheckOperationRequest,
  createVariantCheckOperation,
  decodeVariantCheckReceiptResult,
  parseVariantCheckOperation,
  type VariantCheckOperation,
} from '../src/domain/variant-check-receipt';

const identity: Omit<VariantCheckOperation, 'operationKey' | 'requestHash'> = {
  taskId: '10000000-0000-4000-8000-000000000001',
  userId: 'fixture-owner',
  taskCreatedAt: '2026-09-13T00:00:00.000Z',
  expiresAt: '2026-09-20T00:00:00.000Z',
  taskType: 'variant-check',
  taskSubType: 'asin-check',
  step: 'result',
  resultKind: 'asin',
};
const request = { asinId: 'a1', forceRefresh: true };
const view = {
  asin: '',
  title: '',
  hasVariation: false,
  isBroken: false,
  parentAsin: null,
  brotherAsins: [],
  brand: null,
  raw: {
    details: {
      title: 'Full original data',
      relationships: [{ childAsins: ['B000000002'] }],
    },
  },
};

describe('Variant check operation identity and complete receipt payload', () => {
  it('keeps the same operation for reordered request fields, but detects changed request content', () => {
    const first = createVariantCheckOperation(identity, request);
    expect(
      createVariantCheckOperation(identity, {
        forceRefresh: true,
        asinId: 'a1',
      }),
    ).toEqual(first);
    const changed = createVariantCheckOperation(identity, {
      ...request,
      forceRefresh: false,
    });
    expect(changed.operationKey).toBe(first.operationKey);
    expect(changed.requestHash).not.toBe(first.requestHash);
    expect(() =>
      assertVariantCheckOperationRequest(first, request),
    ).not.toThrow();
    expect(() =>
      assertVariantCheckOperationRequest(first, { ...request, asinId: 'a2' }),
    ).toThrow(VariantCheckError);
  });
  it('binds ownership and the exact task creation instance to the operation', () => {
    const first = createVariantCheckOperation(identity, request);
    for (const changed of [
      { ...identity, userId: 'different-owner' },
      { ...identity, taskCreatedAt: '2026-09-13T00:00:00.001Z' },
    ])
      expect(
        createVariantCheckOperation(changed, request).operationKey,
      ).not.toBe(first.operationKey);
    expect(() =>
      parseVariantCheckOperation({ ...first, userId: 'different-owner' }),
    ).toThrow(VariantCheckError);
  });
  it('keeps batch group steps separate from one another and the final batch result', () => {
    const batch = {
      ...identity,
      taskType: 'batch-check' as const,
      taskSubType: 'variant-group' as const,
      resultKind: 'group' as const,
    };
    const first = createVariantCheckOperation(
      { ...batch, step: 'group-0' },
      { groupId: 'g1', forceRefresh: false },
    );
    const second = createVariantCheckOperation(
      { ...batch, step: 'group-1' },
      { groupId: 'g1', forceRefresh: false },
    );
    expect(first.operationKey).not.toBe(second.operationKey);
    expect(() =>
      createVariantCheckOperation({ ...batch, step: 'result' }, request),
    ).toThrow(VariantCheckError);
    expect(() =>
      createVariantCheckOperation(
        { ...batch, step: 'result', resultKind: 'batch' },
        { groupIds: ['g1'] },
      ),
    ).not.toThrow();
  });
  it.each([
    { userId: '' },
    { userId: 'private\nowner' },
    { taskId: '../different-task' },
    { expiresAt: identity.taskCreatedAt },
    { expiresAt: '2027-09-14T00:00:00.000Z' },
    { taskCreatedAt: '2026-09-13T00:00:00Z' },
    { step: 'group-1000' },
    { resultKind: 'parent' },
  ])('rejects invalid or incompatible operation identity %j', (patch) => {
    expect(() =>
      createVariantCheckOperation(
        { ...identity, ...patch } as typeof identity,
        request,
      ),
    ).toThrow(VariantCheckError);
  });
  it.each([
    undefined,
    NaN,
    Infinity,
    new Date(),
    { value: undefined },
    { data: 'x'.repeat(128 * 1024) },
  ])(
    'rejects request values that cannot form a bounded reproducible identity',
    (value) => {
      expect(() => createVariantCheckOperation(identity, value)).toThrow(
        VariantCheckError,
      );
    },
  );
  it('retains all complete raw fields while detaching stored results', () => {
    const result = decodeVariantCheckReceiptResult(view, 'asin');
    expect(result).toEqual(view);
    expect(result).not.toBe(view);
    expect((result as typeof view).raw).not.toBe(view.raw);
  });
  it('rejects a wrong result domain, malformed parent array and oversized complete raw result', () => {
    expect(() => decodeVariantCheckReceiptResult(view, 'group')).toThrow(
      VariantCheckError,
    );
    expect(() =>
      decodeVariantCheckReceiptResult([{ asin: 'B000000001' }], 'parent'),
    ).toThrow(VariantCheckError);
    expect(() =>
      decodeVariantCheckReceiptResult(
        { ...view, raw: 'x'.repeat(32 * 1024 * 1024) },
        'asin',
      ),
    ).toThrow(VariantCheckError);
  });
});
