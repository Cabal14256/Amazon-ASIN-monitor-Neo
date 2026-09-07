import type { ASIN_MANUAL_BROKEN_ACTIONS } from '@asin-monitor/contracts';
import type { AsinGroupReadResult } from '../repositories/asin-query-repository';
import type { Asin, NewMonitorHistory, VariantGroup } from '../schema';
import {
  resolveAsinVariantStatus,
  resolveGroupVariantStatus,
} from './variant-status';

export interface GroupManualFields {
  markedBroken: boolean;
  reason: string;
}
export interface AsinManualFields {
  action: (typeof ASIN_MANUAL_BROKEN_ACTIONS)[number];
  reason: string;
}
export const manualActor = (actor: string | null) =>
  actor ? actor.trim().slice(0, 100) : null;

export function nextAsinManualState(
  row: Asin,
  fields: AsinManualFields,
  time: Date,
  actor: string | null,
) {
  const previous = resolveAsinVariantStatus(row);
  // Legacy initializes all eight fields from the decorated own/exclusion state.
  // Inactive historical exclusion metadata is therefore cleared on any action.
  const next = {
    manualBroken: previous.selfManualBroken === 1,
    manualBrokenReason: previous.selfManualBrokenReason,
    manualBrokenUpdatedAt: previous.selfManualBrokenUpdatedAt,
    manualBrokenUpdatedBy: previous.selfManualBrokenUpdatedBy,
    manualExcludedFromGroup: previous.manualExcludedFromGroup === 1,
    manualExcludedReason: previous.manualExcludedReason,
    manualExcludedUpdatedAt: previous.manualExcludedUpdatedAt,
    manualExcludedUpdatedBy: previous.manualExcludedUpdatedBy,
  };
  switch (fields.action) {
    case 'MARK_BROKEN':
      Object.assign(next, {
        manualBroken: true,
        manualBrokenReason: fields.reason || null,
        manualBrokenUpdatedAt: time,
        manualBrokenUpdatedBy: manualActor(actor),
      });
      break;
    case 'CLEAR_SELF_MANUAL':
      Object.assign(next, {
        manualBroken: false,
        manualBrokenReason: null,
        manualBrokenUpdatedAt: null,
        manualBrokenUpdatedBy: null,
      });
      break;
    case 'EXCLUDE_GROUP_MANUAL':
      Object.assign(next, {
        manualExcludedFromGroup: true,
        manualExcludedReason: fields.reason || null,
        manualExcludedUpdatedAt: time,
        manualExcludedUpdatedBy: manualActor(actor),
      });
      break;
    case 'CLEAR_GROUP_EXCLUSION':
      Object.assign(next, {
        manualExcludedFromGroup: false,
        manualExcludedReason: null,
        manualExcludedUpdatedAt: null,
        manualExcludedUpdatedBy: null,
      });
      break;
  }
  return next;
}
type ManualStatus = ReturnType<typeof resolveGroupVariantStatus>;
function commonResult(
  previous: ManualStatus,
  current: ManualStatus,
  time: Date,
  actor: string | null,
  reason: string,
) {
  return {
    source: 'MANUAL_ACTION',
    operator: actor || null,
    reason: reason || '',
    statusSource: current.statusSource,
    manualBroken: current.manualBroken,
    autoIsBroken: current.autoIsBroken,
    effectiveIsBroken: current.isBroken,
    previousStatusSource: previous.statusSource,
    previousManualBroken: previous.manualBroken,
    previousAutoIsBroken: previous.autoIsBroken,
    previousEffectiveIsBroken: previous.isBroken,
    manualBrokenReason: current.manualBrokenReason || '',
    manualBrokenUpdatedAt: current.manualBrokenUpdatedAt || time,
    manualBrokenUpdatedBy: current.manualBrokenUpdatedBy || actor || null,
  };
}
function exclusionResult(current: ReturnType<typeof resolveAsinVariantStatus>) {
  return {
    manualBrokenScope: current.manualBrokenScope,
    manualExcludedFromGroup: current.manualExcludedFromGroup,
    manualExcludedReason: current.manualExcludedReason || '',
    manualExcludedUpdatedAt: current.manualExcludedUpdatedAt || null,
    manualExcludedUpdatedBy: current.manualExcludedUpdatedBy || null,
  };
}
function country(value: string): string {
  // Legacy inserts NULL for an empty country and the NOT NULL constraint fails.
  if (!value) throw new Error('Manual history country is missing');
  return value;
}
function snapshot(row: Asin | VariantGroup) {
  return { siteSnapshot: row.site || null, brandSnapshot: row.brand || null };
}
export function asinManualHistory(
  previous: Asin,
  current: Asin,
  group: VariantGroup,
  fields: AsinManualFields,
  time: Date,
  actor: string | null,
): NewMonitorHistory {
  const before = resolveAsinVariantStatus(previous, group);
  const after = resolveAsinVariantStatus(current, group);
  return {
    ...snapshot(previous),
    asinId: previous.id,
    asinCode: previous.asin || null,
    asinName: previous.name || null,
    variantGroupId: group.id,
    variantGroupName: group.name || null,
    checkType: 'ASIN',
    country: country(previous.country),
    isBroken: after.isBroken === 1,
    checkTime: time,
    createTime: time,
    checkResult: {
      ...commonResult(
        before,
        after,
        time,
        manualActor(actor) || actor,
        fields.reason ||
          before.manualBrokenReason ||
          before.manualExcludedReason ||
          '',
      ),
      ...exclusionResult(after),
      entityType: 'ASIN',
      action: fields.action,
    },
  };
}
export function* groupManualHistory(
  previous: AsinGroupReadResult,
  current: AsinGroupReadResult,
  fields: GroupManualFields,
  time: Date,
  actor: string | null,
): Generator<NewMonitorHistory> {
  const beforeGroup = previous.groups[0];
  const afterGroup = current.groups[0];
  if (
    previous.groups.length !== 1 ||
    current.groups.length !== 1 ||
    beforeGroup.id !== afterGroup.id
  )
    throw new Error('Invalid manual group history snapshot');
  const previousChildren = new Map(previous.asins.map((row) => [row.id, row]));
  const beforeStates = previous.asins.map((row) =>
    resolveAsinVariantStatus(row, beforeGroup),
  );
  const afterStates = current.asins.map((row) =>
    resolveAsinVariantStatus(row, afterGroup),
  );
  const before = resolveGroupVariantStatus(beforeGroup, beforeStates);
  const after = resolveGroupVariantStatus(afterGroup, afterStates);
  const operator = (fields.markedBroken ? manualActor(actor) : null) || actor;
  const reason = fields.markedBroken
    ? fields.reason
    : before.manualBrokenReason || '';
  yield {
    ...snapshot(beforeGroup),
    variantGroupId: beforeGroup.id,
    variantGroupName: beforeGroup.name || null,
    checkType: 'GROUP',
    country: country(beforeGroup.country),
    isBroken: after.isBroken === 1,
    checkTime: time,
    createTime: time,
    checkResult: {
      ...commonResult(before, after, time, operator, reason),
      entityType: 'GROUP',
      action: fields.markedBroken ? 'MARK_BROKEN' : 'CLEAR_MANUAL_BROKEN',
    },
  };
  for (let index = 0; index < current.asins.length; index++) {
    const row = current.asins[index];
    const old = previousChildren.get(row.id);
    if (!old || row.variantGroupId !== afterGroup.id)
      throw new Error('Invalid manual child history snapshot');
    const oldState = resolveAsinVariantStatus(old, beforeGroup);
    const newState = afterStates[index];
    yield {
      ...snapshot(row),
      asinId: row.id,
      asinCode: row.asin || null,
      asinName: row.name || null,
      variantGroupId: afterGroup.id,
      variantGroupName: afterGroup.name || beforeGroup.name || null,
      checkType: 'ASIN',
      country: country(row.country || beforeGroup.country),
      isBroken: newState.isBroken === 1,
      checkTime: time,
      createTime: time,
      checkResult: {
        ...commonResult(oldState, newState, time, operator, reason),
        ...exclusionResult(newState),
        entityType: 'ASIN',
        action: fields.markedBroken
          ? 'APPLY_GROUP_MANUAL_BROKEN'
          : 'CLEAR_GROUP_MANUAL_BROKEN',
        variantGroupId: afterGroup.id,
        variantGroupName: afterGroup.name || null,
      },
    };
  }
}
