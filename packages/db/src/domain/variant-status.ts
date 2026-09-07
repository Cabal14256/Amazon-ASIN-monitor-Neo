/** Effective state shared by PostgreSQL readers and future business writers.
 * Group exclusion suppresses inherited manual state only, never automatic or
 * the ASIN's own manual state. Metadata retains the Legacy precedence rules.
 */
export interface ManualVariantState {
  manualBroken?: boolean | null;
  manualBrokenReason?: string | null;
  manualBrokenUpdatedAt?: Date | null;
  manualBrokenUpdatedBy?: string | null;
}
export interface AsinVariantState extends ManualVariantState {
  isBroken?: boolean | null;
  manualExcludedFromGroup?: boolean | null;
  manualExcludedReason?: string | null;
  manualExcludedUpdatedAt?: Date | null;
  manualExcludedUpdatedBy?: string | null;
}
const flag = (value: boolean | null | undefined): 0 | 1 =>
  value === true ? 1 : 0;
export function effectiveVariantStatus(auto: boolean, manual: boolean) {
  return {
    isBroken: flag(auto || manual),
    variantStatus: auto || manual ? ('BROKEN' as const) : ('NORMAL' as const),
    autoIsBroken: flag(auto),
    autoVariantStatus: auto ? ('BROKEN' as const) : ('NORMAL' as const),
    manualBroken: flag(manual),
    statusSource:
      auto && manual
        ? ('AUTO+MANUAL' as const)
        : manual
        ? ('MANUAL' as const)
        : auto
        ? ('AUTO' as const)
        : ('NORMAL' as const),
  };
}
export function resolveAsinVariantStatus(
  record: AsinVariantState,
  parent: ManualVariantState = {},
) {
  const self = record.manualBroken === true;
  const excluded = record.manualExcludedFromGroup === true;
  const rawInherited = parent.manualBroken === true;
  const inherited = rawInherited && !excluded;
  const ownReason = record.manualBrokenReason || null;
  const ownAt = record.manualBrokenUpdatedAt || null;
  const ownBy = record.manualBrokenUpdatedBy || null;
  const parentReason = inherited ? parent.manualBrokenReason || null : null;
  const parentAt = inherited ? parent.manualBrokenUpdatedAt || null : null;
  const parentBy = inherited ? parent.manualBrokenUpdatedBy || null : null;
  return {
    ...effectiveVariantStatus(record.isBroken === true, self || inherited),
    manualBrokenScope:
      self && inherited
        ? ('SELF+GROUP' as const)
        : self
        ? ('SELF' as const)
        : inherited
        ? ('GROUP' as const)
        : excluded && rawInherited
        ? ('GROUP_EXCLUDED' as const)
        : ('NONE' as const),
    manualBrokenReason: self ? ownReason : parentReason,
    manualBrokenUpdatedAt: self ? ownAt : parentAt,
    manualBrokenUpdatedBy: self ? ownBy : parentBy,
    selfManualBroken: flag(self),
    selfManualBrokenReason: ownReason,
    selfManualBrokenUpdatedAt: ownAt,
    selfManualBrokenUpdatedBy: ownBy,
    manualExcludedFromGroup: flag(excluded),
    manualExcludedReason: excluded ? record.manualExcludedReason || null : null,
    manualExcludedUpdatedAt: excluded
      ? record.manualExcludedUpdatedAt || null
      : null,
    manualExcludedUpdatedBy: excluded
      ? record.manualExcludedUpdatedBy || null
      : null,
    inheritedManualBroken: flag(inherited),
    inheritedManualBrokenReason: parentReason,
    inheritedManualBrokenUpdatedAt: parentAt,
    inheritedManualBrokenUpdatedBy: parentBy,
  };
}
export function resolveGroupVariantStatus(
  record: AsinVariantState,
  children: readonly Pick<
    ReturnType<typeof resolveAsinVariantStatus>,
    'autoIsBroken' | 'selfManualBroken'
  >[] = [],
) {
  const own = record.manualBroken === true;
  return {
    ...effectiveVariantStatus(
      record.isBroken === true ||
        children.some((child) => child.autoIsBroken === 1),
      own || children.some((child) => child.selfManualBroken === 1),
    ),
    // The group exposes its own marker; effective status includes its children.
    manualBroken: flag(own),
    manualBrokenReason: record.manualBrokenReason || null,
    manualBrokenUpdatedAt: record.manualBrokenUpdatedAt || null,
    manualBrokenUpdatedBy: record.manualBrokenUpdatedBy || null,
  };
}
