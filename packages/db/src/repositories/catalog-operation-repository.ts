import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Db } from '../client';
import {
  CatalogOperationError,
  parseCatalogIdentity,
  parseCatalogPinId,
  parseCatalogTaskBinding,
  parseCatalogTerminalProof,
  taskMatchesCatalogOperation,
  type CatalogOperationAuthorize,
  type CatalogOperationDomain,
  type CatalogOperationIdentity,
  type CatalogOperationPin,
  type CatalogOperationReservation,
  type CatalogOperationSnapshot,
  type CatalogOperationTerminalProof,
  type CatalogPhysicalOutcome,
  type CatalogTaskBinding,
} from '../domain/catalog-operation';
import { DrizzleAsinQueryUnit } from './asin-query-repository';
import { withAuthDatabaseDeadline } from './bounded-auth-repository';

type SqlDb = Pick<Db, 'execute'>;
type Row = Record<string, unknown>;
function ownerDomain(ownerId: string, domain: CatalogOperationDomain) {
  parseCatalogIdentity({
    ownerId,
    domain,
    operationId: '00000000-0000-4000-8000-000000000000',
    generation: '1',
    kind: 'write',
  });
}
function identityOf(row: Row): CatalogOperationIdentity {
  return parseCatalogIdentity({
    ownerId: row.owner_id,
    domain: row.domain,
    operationId: row.operation_id,
    generation: String(row.generation),
    kind: row.kind,
  });
}
function sameIdentity(row: Row, identity: CatalogOperationIdentity) {
  return JSON.stringify(identityOf(row)) === JSON.stringify(identity);
}
function bindingOf(row: Row): CatalogTaskBinding | null {
  if (row.task_id === null) {
    if (
      [row.task_type, row.task_sub_type, row.task_created_at].some(
        (v) => v !== null,
      )
    )
      throw new CatalogOperationError('CATALOG_OPERATION_INVALID');
    return null;
  }
  return parseCatalogTaskBinding({
    taskId: row.task_id,
    userId: row.owner_id,
    taskType: row.task_type,
    taskSubType: row.task_sub_type,
    createdAt: row.task_created_at,
  });
}
async function readRow(
  db: SqlDb,
  ownerId: string,
  domain: CatalogOperationDomain,
  lock?: 'UPDATE' | 'SHARE' | 'UPDATE NOWAIT',
): Promise<Row | undefined> {
  const result = await db.execute(sql`
    SELECT *, generation::text AS generation FROM catalog_operation_slots
    WHERE owner_id=${ownerId} AND domain=${domain}
    ${lock ? sql.raw(`FOR ${lock}`) : sql``}
  `);
  if (result.rows.length > 1)
    throw new CatalogOperationError('CATALOG_OPERATION_INVALID');
  return result.rows[0];
}
function slotContention(error: unknown): boolean {
  // Drizzle wraps PostgreSQL errors in cause. This mapping is used only for
  // reservation slot INSERT/lock statements, never authorization or IO.
  const visited = new Set<object>();
  for (
    let depth = 0;
    depth < 8 && error && typeof error === 'object';
    depth++
  ) {
    if (visited.has(error)) return false;
    visited.add(error);
    const value = error as { code?: unknown; cause?: unknown };
    if (value.code === '55P03' || value.code === '57014') return true;
    error = value.cause;
  }
  return false;
}
async function requireRow(
  db: SqlDb,
  identity: CatalogOperationIdentity,
  lock: 'UPDATE' | 'SHARE',
): Promise<Row> {
  const row = await readRow(db, identity.ownerId, identity.domain, lock);
  if (!row || row.state === 'idle')
    throw new CatalogOperationError('CATALOG_OPERATION_MISSING');
  if (!sameIdentity(row, identity))
    throw new CatalogOperationError('CATALOG_OPERATION_IDENTITY');
  return row;
}
function requireOpen(row: Row) {
  if (row.state === 'uncertain')
    throw new CatalogOperationError('CATALOG_OPERATION_UNCERTAIN');
  if (row.state !== 'open')
    throw new CatalogOperationError('CATALOG_OPERATION_CLOSED');
}
async function snapshot(
  db: SqlDb,
  row: Row,
): Promise<CatalogOperationSnapshot> {
  const identity = identityOf(row);
  if (!['open', 'closed', 'uncertain'].includes(String(row.state)))
    throw new CatalogOperationError('CATALOG_OPERATION_INVALID');
  const counts = await db.execute(sql`
    SELECT count(*) FILTER (WHERE state='pending')::text AS pending,
           count(*) FILTER (WHERE state='uncertain')::text AS uncertain
    FROM catalog_operation_pins WHERE owner_id=${identity.ownerId}
      AND domain=${identity.domain} AND generation=${identity.generation}::bigint
      AND operation_id=${identity.operationId}::uuid
  `);
  const pendingPins = Number(counts.rows[0]?.pending);
  const uncertainPins = Number(counts.rows[0]?.uncertain);
  if (
    ![pendingPins, uncertainPins].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    )
  )
    throw new CatalogOperationError('CATALOG_OPERATION_INVALID');
  const terminal =
    row.terminal === null ? null : parseCatalogTerminalProof(row.terminal);
  return {
    ...identity,
    state: row.state as CatalogOperationSnapshot['state'],
    expectedTaskId: row.expected_task_id as string | null,
    task: bindingOf(row),
    pendingPins,
    uncertainPins,
    terminal,
  };
}

/** Lives only in the primary database. No TTL, task-meta lookup or optimistic
 * absent-job cleanup can remove a reservation. Callers own current authorization. */
export class PgCatalogOperationRepository {
  constructor(private readonly pool: Pool) {}
  private run<T>(work: (db: Db, ensureOpen: () => void) => Promise<T>) {
    return withAuthDatabaseDeadline(this.pool, async (db, ensureOpen) => {
      await db.execute(sql`SET TRANSACTION ISOLATION LEVEL READ COMMITTED`);
      ensureOpen();
      return work(db, ensureOpen);
    });
  }
  reserve(
    request: CatalogOperationReservation,
    authorize: CatalogOperationAuthorize,
  ): Promise<CatalogOperationIdentity> {
    const identity = parseCatalogIdentity({
      ownerId: request.ownerId,
      domain: request.domain,
      operationId: request.operationId ?? randomUUID(),
      generation: '1',
      kind: request.kind,
    });
    if (
      request.expectedTaskId !== undefined &&
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
        request.expectedTaskId,
      )
    )
      throw new CatalogOperationError('CATALOG_OPERATION_INVALID');
    if (identity.kind === 'write' && request.expectedTaskId)
      throw new CatalogOperationError('CATALOG_OPERATION_INVALID');
    return this.run(async (db, ensureOpen) => {
      await db.execute(
        sql`SELECT pg_advisory_xact_lock_shared(1095977294,1380073795)`,
      );
      // INSERT's unique-key arbitration covers the first reservation as well.
      // Slot before owner/session matches actual execution's held slot lock.
      // Authorizing first could deadlock against a running transaction waiting
      // for the same owner lock. Failed authorization rolls this INSERT back.
      let row: Row | undefined;
      try {
        await db.execute(sql`
          INSERT INTO catalog_operation_slots(owner_id,domain)
          VALUES(${identity.ownerId},${identity.domain}) ON CONFLICT DO NOTHING
        `);
        row = await readRow(
          db,
          identity.ownerId,
          identity.domain,
          'UPDATE NOWAIT',
        );
      } catch (error) {
        if (slotContention(error))
          throw new CatalogOperationError('CATALOG_OPERATION_BUSY');
        throw error;
      }
      if (!row) throw new CatalogOperationError('CATALOG_OPERATION_DEPENDENCY');
      await authorize(new DrizzleAsinQueryUnit(db, ensureOpen));
      ensureOpen();
      if (row.state !== 'idle')
        throw new CatalogOperationError(
          'CATALOG_OPERATION_BUSY',
          await snapshot(db, row),
        );
      const generation = BigInt(String(row.generation)) + 1n;
      const accepted = parseCatalogIdentity({
        ...identity,
        generation: generation.toString(),
      });
      await db.execute(sql`
        UPDATE catalog_operation_slots SET generation=${
          accepted.generation
        }::bigint,
          operation_id=${accepted.operationId}::uuid,kind=${
        accepted.kind
      },state='open',
          expected_task_id=${request.expectedTaskId ?? null}::uuid,
          task_id=NULL,task_type=NULL,task_sub_type=NULL,task_created_at=NULL,terminal=NULL,
          updated_at=statement_timestamp()
        WHERE owner_id=${accepted.ownerId} AND domain=${accepted.domain}
      `);
      ensureOpen();
      return accepted;
    });
  }
  bindTask(
    raw: CatalogOperationIdentity,
    input: CatalogTaskBinding,
  ): Promise<void> {
    const identity = parseCatalogIdentity(raw),
      task = parseCatalogTaskBinding(input);
    if (!taskMatchesCatalogOperation(identity, task))
      throw new CatalogOperationError('CATALOG_OPERATION_IDENTITY');
    return this.run(async (db, ensureOpen) => {
      const row = await requireRow(db, identity, 'UPDATE');
      requireOpen(row);
      if (row.expected_task_id !== null && row.expected_task_id !== task.taskId)
        throw new CatalogOperationError('CATALOG_OPERATION_IDENTITY');
      const current = bindingOf(row);
      if (current) {
        if (JSON.stringify(current) !== JSON.stringify(task))
          throw new CatalogOperationError('CATALOG_OPERATION_IDENTITY');
        return;
      }
      await db.execute(sql`
        UPDATE catalog_operation_slots SET expected_task_id=${task.taskId}::uuid,task_id=${task.taskId}::uuid,
          task_type=${task.taskType},task_sub_type=${task.taskSubType},task_created_at=${task.createdAt},
          updated_at=statement_timestamp()
        WHERE owner_id=${identity.ownerId} AND domain=${identity.domain}
      `);
      ensureOpen();
    });
  }
  read(
    ownerId: string,
    domain: CatalogOperationDomain,
  ): Promise<CatalogOperationSnapshot | null> {
    ownerDomain(ownerId, domain);
    return this.run(async (db) => {
      const row = await readRow(db, ownerId, domain, 'SHARE');
      return !row || row.state === 'idle' ? null : snapshot(db, row);
    });
  }
  findByTask(input: CatalogTaskBinding): Promise<CatalogOperationIdentity> {
    const task = parseCatalogTaskBinding(input);
    return this.run(async (db) => {
      const result = await db.execute(sql`
        SELECT *, generation::text AS generation FROM catalog_operation_slots
        WHERE owner_id=${task.userId} AND task_id=${task.taskId}::uuid AND state<>'idle'
        FOR SHARE
      `);
      if (result.rows.length !== 1)
        throw new CatalogOperationError('CATALOG_OPERATION_MISSING');
      const row = result.rows[0],
        identity = identityOf(row);
      if (
        JSON.stringify(bindingOf(row)) !== JSON.stringify(task) ||
        !taskMatchesCatalogOperation(identity, task)
      )
        throw new CatalogOperationError('CATALOG_OPERATION_IDENTITY');
      // A closed identity can be inspected/settled, but cannot start execution.
      return identity;
    });
  }
  beginPin(raw: CatalogOperationIdentity): Promise<CatalogOperationPin> {
    const identity = parseCatalogIdentity(raw),
      pinId = randomUUID();
    return this.run(async (db, ensureOpen) => {
      const row = await requireRow(db, identity, 'SHARE');
      requireOpen(row);
      await db.execute(sql`
        INSERT INTO catalog_operation_pins(pin_id,owner_id,domain,generation,operation_id)
        VALUES(${pinId}::uuid,${identity.ownerId},${identity.domain},${identity.generation}::bigint,${identity.operationId}::uuid)
      `);
      ensureOpen();
      return { identity, pinId };
    });
  }
  /** In the ACTUAL primary authorization/business transaction. Its shared slot
   * and pin locks remain held through primary or competitor COMMIT. */
  async assertPin(db: SqlDb, pin: CatalogOperationPin): Promise<void> {
    const identity = parseCatalogIdentity(pin.identity);
    parseCatalogPinId(pin.pinId);
    const row = await requireRow(db, identity, 'SHARE');
    requireOpen(row);
    const result = await db.execute(sql`
      SELECT state FROM catalog_operation_pins WHERE pin_id=${pin.pinId}::uuid
        AND owner_id=${identity.ownerId} AND domain=${identity.domain}
        AND generation=${identity.generation}::bigint AND operation_id=${identity.operationId}::uuid
      FOR SHARE
    `);
    if (result.rows.length !== 1 || result.rows[0].state !== 'pending')
      throw new CatalogOperationError('CATALOG_OPERATION_IDENTITY');
  }
  finishPin(
    pin: CatalogOperationPin,
    outcome: CatalogPhysicalOutcome,
  ): Promise<void> {
    const identity = parseCatalogIdentity(pin.identity);
    parseCatalogPinId(pin.pinId);
    if (!['committed', 'rolled-back', 'uncertain'].includes(outcome))
      throw new CatalogOperationError('CATALOG_OPERATION_INVALID');
    return this.run(async (db, ensureOpen) => {
      await requireRow(db, identity, 'UPDATE');
      const rows = await db.execute(sql`
        UPDATE catalog_operation_pins SET state=${
          outcome === 'uncertain' ? 'uncertain' : 'settled'
        },
          outcome=${
            outcome === 'uncertain' ? null : outcome
          },settled_at=statement_timestamp()
        WHERE pin_id=${pin.pinId}::uuid AND owner_id=${
        identity.ownerId
      } AND domain=${identity.domain}
          AND generation=${identity.generation}::bigint AND operation_id=${
        identity.operationId
      }::uuid AND state='pending'
        RETURNING pin_id
      `);
      if (rows.rows.length !== 1)
        throw new CatalogOperationError('CATALOG_OPERATION_IDENTITY');
      if (outcome === 'uncertain')
        await db.execute(sql`
          UPDATE catalog_operation_slots SET state='uncertain',updated_at=statement_timestamp()
          WHERE owner_id=${identity.ownerId} AND domain=${identity.domain}
        `);
      ensureOpen();
    });
  }
  close(
    raw: CatalogOperationIdentity,
    input?: CatalogOperationTerminalProof,
  ): Promise<void> {
    const identity = parseCatalogIdentity(raw);
    const proof = input ? parseCatalogTerminalProof(input) : undefined;
    return this.run(async (db, ensureOpen) => {
      const row = await requireRow(db, identity, 'UPDATE');
      if (proof) {
        const task = bindingOf(row);
        if (
          (proof.source === 'sync' && (task || proof.task)) ||
          (proof.source !== 'sync' &&
            (!task || JSON.stringify(proof.task) !== JSON.stringify(task))) ||
          (proof.source === 'cancel' && proof.status !== 'cancelled')
        )
          throw new CatalogOperationError('CATALOG_OPERATION_IDENTITY');
        if (row.terminal !== null) {
          const previous = parseCatalogTerminalProof(row.terminal);
          const cancelledTogether =
            previous.status === 'cancelled' &&
            proof.status === 'cancelled' &&
            ['cancel', 'worker'].includes(previous.source) &&
            ['cancel', 'worker'].includes(proof.source) &&
            JSON.stringify(previous.task) === JSON.stringify(proof.task);
          if (
            JSON.stringify(previous) !== JSON.stringify(proof) &&
            !cancelledTogether
          )
            throw new CatalogOperationError('CATALOG_OPERATION_IDENTITY');
        }
      }
      await db.execute(sql`
        UPDATE catalog_operation_slots SET state=CASE WHEN state='uncertain' THEN state ELSE 'closed' END,
          terminal=COALESCE(terminal,${
            proof ? JSON.stringify(proof) : null
          }::jsonb),updated_at=statement_timestamp()
        WHERE owner_id=${identity.ownerId} AND domain=${identity.domain}
      `);
      ensureOpen();
    });
  }
  release(raw: CatalogOperationIdentity): Promise<boolean> {
    const identity = parseCatalogIdentity(raw);
    return this.run(async (db, ensureOpen) => {
      const row = await requireRow(db, identity, 'UPDATE');
      const status = await snapshot(db, row);
      if (
        status.state !== 'closed' ||
        !status.terminal ||
        status.pendingPins ||
        status.uncertainPins
      )
        return false;
      await db.execute(sql`
        DELETE FROM catalog_operation_pins WHERE owner_id=${identity.ownerId} AND domain=${identity.domain}
          AND generation=${identity.generation}::bigint AND operation_id=${identity.operationId}::uuid AND state='settled'
      `);
      await db.execute(sql`
        UPDATE catalog_operation_slots SET state='idle',operation_id=NULL,kind=NULL,
          expected_task_id=NULL,task_id=NULL,task_type=NULL,task_sub_type=NULL,task_created_at=NULL,
          terminal=NULL,updated_at=statement_timestamp()
        WHERE owner_id=${identity.ownerId} AND domain=${identity.domain}
      `);
      ensureOpen();
      return true;
    });
  }
}
