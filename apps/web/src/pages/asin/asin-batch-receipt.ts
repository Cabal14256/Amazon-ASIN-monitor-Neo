import {
  batchCreateAsinsDataSchema,
  batchCreateAsinsRequestSchema,
  type BatchCreateAsinsData,
} from '@asin-monitor/contracts';
import {
  validBatchCreateText,
  type AsinBatchCreateInput,
} from '../../services/asin-batch-create';

export interface AsinBatchReceipt {
  operationId: string;
  owner: string;
  groupId: string;
  groupName: string;
  submittedAt: number;
  items: AsinBatchCreateInput['items'];
  result: BatchCreateAsinsData;
}
type ReceiptStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export const asinBatchReceiptKey = (userId: string) =>
  `neo:asin-batch-create-receipt:${encodeURIComponent(userId)}`;
const headKey = (userId: string, owner: string) =>
  `${asinBatchReceiptKey(userId)}:${encodeURIComponent(owner)}`;
const operationKey = (userId: string, owner: string, operationId: string) =>
  `${headKey(userId, owner)}:${operationId}`;
const strict = (
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));

/** Revalidate stored receipts against their complete original submission. */
export function parseAsinBatchReceipt(
  raw: string | null,
): AsinBatchReceipt | null {
  if (!raw || raw.length > 2 * 1024 * 1024) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (
      !strict(value, [
        'operationId',
        'owner',
        'groupId',
        'groupName',
        'submittedAt',
        'items',
        'result',
      ]) ||
      typeof value.operationId !== 'string' ||
      !/^[a-z0-9-]{1,80}$/i.test(value.operationId) ||
      typeof value.owner !== 'string' ||
      value.owner.length > 1000 ||
      typeof value.groupId !== 'string' ||
      !value.groupId.trim() ||
      [...value.groupId].length > 50 ||
      typeof value.groupName !== 'string' ||
      [...value.groupName].length > 256 ||
      !Number.isSafeInteger(value.submittedAt) ||
      (value.submittedAt as number) < 0 ||
      !Array.isArray(value.items) ||
      value.items.length < 1 ||
      value.items.length > 1000 ||
      value.items.some(
        (item) =>
          !strict(item, [
            'asin',
            'country',
            'parentId',
            'site',
            'brand',
            'name',
            'asinType',
          ]),
      )
    )
      return null;
    const input = batchCreateAsinsRequestSchema.safeParse({
      items: value.items,
    });
    const parsed = batchCreateAsinsDataSchema.safeParse(value.result);
    const owner: unknown = JSON.parse(value.owner);
    if (
      !Array.isArray(owner) ||
      owner.length !== 3 ||
      owner[0] !== 'asin' ||
      typeof owner[1] !== 'string' ||
      !owner[1] ||
      (owner[2] !== null && typeof owner[2] !== 'string')
    )
      return null;
    if (
      !input.success ||
      !parsed.success ||
      !strict(value.result, [
        'total',
        'successCount',
        'failedCount',
        'results',
        'errors',
      ])
    )
      return null;
    const items = input.data.items;
    const result = parsed.data;
    const seen = new Set<number>();
    const failed = new Set<number>();
    if (
      items.some(
        (item) =>
          !/^[A-Z0-9]{10}$/.test(item.asin) ||
          item.parentId !== value.groupId ||
          !validBatchCreateText(item.parentId, 50, true) ||
          !validBatchCreateText(item.country, 10, true) ||
          item.country !== item.country.trim().toUpperCase() ||
          !validBatchCreateText(item.site, 100, true) ||
          !validBatchCreateText(item.brand, 100, true) ||
          !validBatchCreateText(item.name, 500),
      ) ||
      ![result.total, result.successCount, result.failedCount].every(
        (count) => Number.isSafeInteger(count) && count >= 0,
      ) ||
      result.total !== items.length ||
      result.total !== result.successCount + result.failedCount ||
      result.results.length !== result.total ||
      result.errors.length !== result.failedCount ||
      result.results.filter((row) => row.success).length !== result.successCount
    )
      return null;
    for (const row of result.results) {
      const item = items[row.index];
      if (
        !strict(row, [
          'index',
          'asin',
          'country',
          'success',
          'message',
          'id',
          'parentId',
        ]) ||
        !Number.isInteger(row.index) ||
        seen.has(row.index) ||
        !item ||
        row.asin !== item.asin ||
        row.country !== item.country ||
        (!row.success && !row.message?.trim()) ||
        (row.id !== undefined && typeof row.id !== 'string') ||
        (row.parentId !== undefined &&
          (typeof row.parentId !== 'string' ||
            !validBatchCreateText(row.parentId, 50, true) ||
            // Both producers normalize parentId before adding success rows.
            row.parentId !== item.parentId?.trim()))
      )
        return null;
      seen.add(row.index);
    }
    for (const error of result.errors) {
      const row = result.results.find((item) => item.index === error.index);
      if (
        !strict(error, ['index', 'asin', 'country', 'message']) ||
        error.index === undefined ||
        failed.has(error.index) ||
        !row ||
        row.success ||
        error.message !== row.message ||
        (error.asin != null && error.asin !== row.asin) ||
        (error.country != null && error.country !== row.country)
      )
        return null;
      failed.add(error.index);
    }
    return value as unknown as AsinBatchReceipt;
  } catch {
    return null;
  }
}
export function browserReceiptStorage(): {
  local: ReceiptStorage | null;
  session: ReceiptStorage | null;
} {
  let local: ReceiptStorage | null = null;
  let session: ReceiptStorage | null = null;
  try {
    local = window.localStorage;
  } catch {
    /* Recovery stays protected. */
  }
  try {
    session = window.sessionStorage;
  } catch {
    /* Mounted receipt remains visible. */
  }
  return { local, session };
}
export function saveAsinBatchReceipt(
  userId: string,
  receipt: AsinBatchReceipt,
  storage = browserReceiptStorage(),
): boolean {
  const raw = JSON.stringify(receipt);
  if (!parseAsinBatchReceipt(raw)) return false;
  if (JSON.parse(receipt.owner)[1] !== userId) return false;
  const key = operationKey(userId, receipt.owner, receipt.operationId);
  const head = headKey(userId, receipt.owner);
  const store = (area: ReceiptStorage | null) => {
    if (!area) return false;
    area.setItem(key, raw);
    if (area.getItem(key) !== raw) return false;
    const previousId = area.getItem(head);
    const previous =
      previousId && /^[a-z0-9-]{1,80}$/i.test(previousId)
        ? parseAsinBatchReceipt(
            area.getItem(operationKey(userId, receipt.owner, previousId)),
          )
        : null;
    if (!previous || previous.submittedAt <= receipt.submittedAt) {
      area.setItem(head, receipt.operationId);
      if (area.getItem(head) !== receipt.operationId) return false;
    }
    return true;
  };
  try {
    if (store(storage.local)) {
      try {
        storage.session?.removeItem(key);
      } catch {
        /* Durable local receipt wins. */
      }
      return true;
    }
  } catch {
    /* Keep the shared guard and a session receipt fallback. */
  }
  try {
    store(storage.session);
  } catch {
    /* Keep visible in the mounted protection screen. */
  }
  return false;
}
export function readAsinBatchReceipt(
  userId: string,
  owner: string,
  operationId?: string,
  storage = browserReceiptStorage(),
): { receipt: AsinBatchReceipt; persisted: boolean } | null {
  const records: Array<{ receipt: AsinBatchReceipt; persisted: boolean }> = [];
  for (const [area, persisted] of [
    [storage.local, true],
    [storage.session, false],
  ] as const) {
    try {
      const id = operationId ?? area?.getItem(headKey(userId, owner));
      if (!id || !/^[a-z0-9-]{1,80}$/i.test(id)) continue;
      const receipt = parseAsinBatchReceipt(
        area?.getItem(operationKey(userId, owner, id)) ?? null,
      );
      if (
        receipt &&
        receipt.owner === owner &&
        JSON.parse(receipt.owner)[1] === userId &&
        (!operationId || receipt.operationId === operationId)
      )
        records.push({ receipt, persisted });
    } catch {
      /* No unverified receipt is displayed. */
    }
  }
  return (
    records.sort(
      (a, b) =>
        b.receipt.submittedAt - a.receipt.submittedAt ||
        Number(b.persisted) - Number(a.persisted),
    )[0] ?? null
  );
}
export function removeAsinBatchReceipt(
  userId: string,
  expected: AsinBatchReceipt,
  storage = browserReceiptStorage(),
): boolean {
  const key = operationKey(userId, expected.owner, expected.operationId);
  try {
    for (const area of [storage.local, storage.session]) {
      const stored = parseAsinBatchReceipt(area?.getItem(key) ?? null);
      if (
        stored?.operationId === expected.operationId &&
        stored.owner === expected.owner
      ) {
        area?.removeItem(key);
        if (
          area?.getItem(headKey(userId, expected.owner)) ===
          expected.operationId
        )
          area?.removeItem(headKey(userId, expected.owner));
      }
    }
    return true;
  } catch {
    return false;
  }
}
