import { z } from 'zod';
import type { RoleWriteUnit } from '../repositories/role-repository';

const literalOwner = z
  .string()
  .refine(
    (value) =>
      value.length > 0 &&
      [...value].length <= 50 &&
      !/[\x00-\x1f\x7f-\x9f\ud800-\udfff]/u.test(value),
    'Invalid operation owner',
  );
// PostgreSQL uuid output is canonical lower case. Reject another spelling
// rather than conflating differently named Redis tasks during binding.
const literalUuid = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());
export const catalogOperationIdentitySchema = z
  .object({
    ownerId: literalOwner,
    domain: z.enum(['asin', 'competitor']),
    operationId: literalUuid,
    generation: z
      .string()
      .regex(/^[1-9][0-9]{0,18}$/)
      .refine(
        (value) =>
          /^[1-9][0-9]{0,18}$/.test(value) &&
          BigInt(value) <= 9_223_372_036_854_775_807n,
      ),
    kind: z.enum(['write', 'batch-delete', 'import', 'check', 'monitor']),
  })
  .strict();
export type CatalogOperationIdentity = z.infer<
  typeof catalogOperationIdentitySchema
>;
export type CatalogOperationDomain = CatalogOperationIdentity['domain'];
export type CatalogOperationKind = CatalogOperationIdentity['kind'];
export interface CatalogOperationReservation {
  ownerId: string;
  domain: CatalogOperationDomain;
  kind: CatalogOperationKind;
  operationId?: string;
  expectedTaskId?: string;
}

export const catalogTaskBindingSchema = z
  .object({
    taskId: literalUuid,
    userId: literalOwner,
    taskType: z.enum([
      'batch-delete',
      'import',
      'variant-check',
      'batch-check',
      'monitor',
      'competitor-monitor',
    ]),
    taskSubType: z.string().min(1).max(80),
    createdAt: z
      .string()
      .datetime()
      .refine(
        (value) =>
          Number.isFinite(Date.parse(value)) &&
          new Date(value).toISOString() === value,
      ),
  })
  .strict();
export type CatalogTaskBinding = z.infer<typeof catalogTaskBindingSchema>;
export const catalogOperationTerminalProofSchema = z
  .object({
    status: z.enum(['completed', 'failed', 'cancelled', 'rejected']),
    source: z.enum(['sync', 'worker', 'cancel', 'producer']),
    task: catalogTaskBindingSchema.optional(),
  })
  .strict()
  .refine(
    (proof) => proof.source !== 'producer' || proof.status === 'rejected',
    'Producer proof requires a definite submission rejection',
  )
  .refine(
    (proof) =>
      proof.source === 'sync'
        ? proof.task === undefined
        : proof.task !== undefined,
    'Terminal proof must match its synchronous or bound task identity',
  )
  .refine(
    (proof) => proof.source !== 'cancel' || proof.status === 'cancelled',
    'Cancellation proof requires cancelled status',
  );
export type CatalogOperationTerminalProof = z.infer<
  typeof catalogOperationTerminalProofSchema
>;
export interface CatalogOperationSnapshot extends CatalogOperationIdentity {
  state: 'open' | 'closed' | 'uncertain';
  expectedTaskId: string | null;
  task: CatalogTaskBinding | null;
  pendingPins: number;
  uncertainPins: number;
  terminal: CatalogOperationTerminalProof | null;
}
export type CatalogOperationAuthorize = (
  unit: Pick<
    RoleWriteUnit,
    'lockOperator' | 'lockSession' | 'operatorPermissionCodes'
  >,
) => Promise<void>;
export type CatalogOperationErrorCode =
  | 'CATALOG_OPERATION_BUSY'
  | 'CATALOG_OPERATION_MISSING'
  | 'CATALOG_OPERATION_IDENTITY'
  | 'CATALOG_OPERATION_CLOSED'
  | 'CATALOG_OPERATION_UNCERTAIN'
  | 'CATALOG_OPERATION_INVALID'
  | 'CATALOG_OPERATION_DEPENDENCY';
export class CatalogOperationError extends Error {
  constructor(
    readonly code: CatalogOperationErrorCode,
    readonly snapshot?: CatalogOperationSnapshot,
  ) {
    super(code);
    this.name = 'CatalogOperationError';
  }
}
export type CatalogPhysicalOutcome = 'committed' | 'rolled-back' | 'uncertain';
export interface CatalogOperationPin {
  identity: CatalogOperationIdentity;
  pinId: string;
}
export function parseCatalogIdentity(value: unknown): CatalogOperationIdentity {
  const parsed = catalogOperationIdentitySchema.safeParse(value);
  if (!parsed.success)
    throw new CatalogOperationError('CATALOG_OPERATION_INVALID');
  return parsed.data;
}
export function parseCatalogTaskBinding(value: unknown): CatalogTaskBinding {
  const parsed = catalogTaskBindingSchema.safeParse(value);
  if (!parsed.success)
    throw new CatalogOperationError('CATALOG_OPERATION_INVALID');
  return parsed.data;
}
export function parseCatalogTerminalProof(
  value: unknown,
): CatalogOperationTerminalProof {
  const parsed = catalogOperationTerminalProofSchema.safeParse(value);
  if (!parsed.success)
    throw new CatalogOperationError('CATALOG_OPERATION_INVALID');
  return parsed.data;
}
export function parseCatalogPinId(value: unknown): string {
  const parsed = literalUuid.safeParse(value);
  if (!parsed.success)
    throw new CatalogOperationError('CATALOG_OPERATION_INVALID');
  return parsed.data;
}
export function taskMatchesCatalogOperation(
  identity: CatalogOperationIdentity,
  task: CatalogTaskBinding,
): boolean {
  if (task.userId !== identity.ownerId) return false;
  switch (identity.kind) {
    case 'batch-delete':
      return (
        task.taskType === 'batch-delete' &&
        task.taskSubType ===
          (identity.domain === 'asin'
            ? 'variant-group-delete'
            : 'competitor-variant-group-delete')
      );
    case 'import':
      return (
        task.taskType === 'import' &&
        task.taskSubType ===
          (identity.domain === 'asin' ? 'asin' : 'competitor-asin')
      );
    case 'check':
      if (task.taskType === 'batch-check')
        return (
          identity.domain === 'asin' && task.taskSubType === 'variant-group'
        );
      return (
        task.taskType === 'variant-check' &&
        (identity.domain === 'asin'
          ? ['asin-check', 'variant-group-check', 'parent-asin-query'].includes(
              task.taskSubType,
            )
          : [
              'competitor-asin-check',
              'competitor-variant-group-check',
            ].includes(task.taskSubType))
      );
    case 'monitor':
      return identity.domain === 'asin'
        ? task.taskType === 'monitor' && task.taskSubType === 'primary'
        : task.taskType === 'competitor-monitor' &&
            task.taskSubType === 'competitor';
    default:
      return false;
  }
}
