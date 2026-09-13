import { eq, sql } from 'drizzle-orm';
import type { Db } from '../client';
import { VariantCheckError } from '../domain/variant-check';
import {
  decodeVariantCheckReceiptResult,
  parseVariantCheckOperation,
  VARIANT_CHECK_RECEIPT_MAX_BYTES,
  type VariantCheckOperation,
} from '../domain/variant-check-receipt';
import { variantCheckReceipts } from '../schema/variant-check-receipts';

export async function readVariantCheckReceipt(
  db: Db,
  ensureOpen: () => void,
  value: VariantCheckOperation,
  lock: boolean,
): Promise<unknown | undefined> {
  const operation = parseVariantCheckOperation(value);
  ensureOpen();
  if (lock) {
    // Serialize retries of this operation before business group/ASIN row locks.
    // A completed receipt is visible after the previous COMMIT releases the lock.
    await db.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended('neo:variant-check:' || ${operation.operationKey}, 0))`,
    );
    ensureOpen();
  }
  const alive = await db.execute(
    sql`SELECT (${operation.expiresAt}::timestamptz > clock_timestamp()) AS active`,
  );
  ensureOpen();
  if (alive.rows[0]?.active !== true)
    throw new VariantCheckError('operation-expired');
  const [metadata] = await db
    .select({
      taskId: variantCheckReceipts.taskId,
      userId: variantCheckReceipts.userId,
      taskCreatedAt: variantCheckReceipts.taskCreatedAt,
      taskType: variantCheckReceipts.taskType,
      taskSubType: variantCheckReceipts.taskSubType,
      step: variantCheckReceipts.step,
      resultKind: variantCheckReceipts.resultKind,
      requestHash: variantCheckReceipts.requestHash,
      expiresAt: variantCheckReceipts.expiresAt,
      bytes: sql<number>`octet_length(${variantCheckReceipts.result}::text)`,
    })
    .from(variantCheckReceipts)
    .where(eq(variantCheckReceipts.operationKey, operation.operationKey));
  ensureOpen();
  if (!metadata) return undefined;
  for (const key of [
    'taskId',
    'userId',
    'taskCreatedAt',
    'taskType',
    'taskSubType',
    'step',
    'resultKind',
    'requestHash',
  ] as const) {
    if (metadata[key] !== operation[key])
      throw new VariantCheckError('operation-mismatch');
  }
  if (metadata.expiresAt.toISOString() !== operation.expiresAt)
    throw new VariantCheckError('operation-mismatch');
  if (
    !Number.isSafeInteger(metadata.bytes) ||
    metadata.bytes < 1 ||
    metadata.bytes > VARIANT_CHECK_RECEIPT_MAX_BYTES
  )
    throw new VariantCheckError('invalid-result');
  const [stored] = await db
    .select({ result: variantCheckReceipts.result })
    .from(variantCheckReceipts)
    .where(eq(variantCheckReceipts.operationKey, operation.operationKey));
  ensureOpen();
  if (!stored) return undefined;
  return decodeVariantCheckReceiptResult(stored.result, operation.resultKind);
}

export async function saveVariantCheckReceipt(
  db: Db,
  ensureOpen: () => void,
  value: VariantCheckOperation,
  output: unknown,
): Promise<void> {
  const operation = parseVariantCheckOperation(value);
  const result = decodeVariantCheckReceiptResult(output, operation.resultKind);
  ensureOpen();
  const alive = await db.execute(
    sql`SELECT (${operation.expiresAt}::timestamptz > clock_timestamp()) AS active`,
  );
  ensureOpen();
  if (alive.rows[0]?.active !== true)
    throw new VariantCheckError('operation-expired');
  const rows = await db
    .insert(variantCheckReceipts)
    .values({ ...operation, expiresAt: new Date(operation.expiresAt), result })
    .onConflictDoNothing()
    .returning({ operationKey: variantCheckReceipts.operationKey });
  ensureOpen();
  if (rows.length !== 1) throw new VariantCheckError('operation-mismatch');
}

/** Expired operation identities can never execute again. Keep cleanup bounded
 * and skip rows currently owned by another transaction. No business data is deleted. */
export async function purgeVariantCheckReceipts(
  db: Db,
  ensureOpen: () => void,
): Promise<number> {
  ensureOpen();
  const result = await db.execute(sql`
    DELETE FROM ${variantCheckReceipts} WHERE operation_key IN (
      SELECT operation_key FROM ${variantCheckReceipts}
      WHERE expires_at < clock_timestamp() AT TIME ZONE 'Asia/Shanghai'
      ORDER BY expires_at,operation_key LIMIT 500 FOR UPDATE SKIP LOCKED
    )
  `);
  ensureOpen();
  return result.rowCount ?? 0;
}
