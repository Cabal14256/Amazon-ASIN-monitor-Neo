import { isCheckGroupId } from '../../services/catalog-check';
import { isValidTaskId } from '../../services/tasks';

export type CheckTarget =
  | { kind: 'group' | 'asin'; id: string; label: string }
  | { kind: 'batch'; id: 'batch'; label: string; groupIds: string[] };
export interface CatalogCheckGate {
  requestId: string;
  target: CheckTarget;
  submittedAt: number;
  taskId?: string;
}
export function validCatalogCheckGate(
  value: unknown,
): value is CatalogCheckGate {
  if (!value || typeof value !== 'object') return false;
  const gate = value as CatalogCheckGate;
  if (
    typeof gate.requestId !== 'string' ||
    !/^[a-z0-9-]{1,80}$/i.test(gate.requestId) ||
    !Number.isSafeInteger(gate.submittedAt) ||
    gate.submittedAt < 0 ||
    !gate.target ||
    typeof gate.target.label !== 'string' ||
    gate.target.label.length > 2000 ||
    (gate.taskId !== undefined &&
      (typeof gate.taskId !== 'string' || !isValidTaskId(gate.taskId)))
  )
    return false;
  const target = gate.target;
  if (target.kind === 'batch')
    return (
      target.id === 'batch' &&
      Array.isArray(target.groupIds) &&
      target.groupIds.length > 0 &&
      target.groupIds.length <= 1000 &&
      target.groupIds.every(
        (id) => typeof id === 'string' && isCheckGroupId(id),
      ) &&
      new Set(target.groupIds).size === target.groupIds.length
    );
  return (
    ['group', 'asin'].includes(target.kind) &&
    typeof target.id === 'string' &&
    isCheckGroupId(target.id)
  );
}
