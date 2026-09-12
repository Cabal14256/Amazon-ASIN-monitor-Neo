import type {
  VariantGroupCheckData,
  VariantView,
} from '@asin-monitor/contracts';
import { resolveAsinVariantStatus } from '@asin-monitor/db';
import { mapAsinQueryGroups } from './record-mapper';
import {
  VariantCheckError,
  type AsinCheckObservation,
  type CommittedGroupCheck,
  type CommittedSingleCheck,
} from './types';

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
const code = (value: unknown) => {
  if (value && !['string', 'number', 'boolean'].includes(typeof value))
    throw new VariantCheckError('invalid-result');
  return String(value || '')
    .trim()
    .toUpperCase();
};
const optionalText = (value: unknown): string => {
  if (!value) return '';
  if (typeof value !== 'string') throw new VariantCheckError('invalid-result');
  return value;
};

/** Frozen Legacy view projection, including the nested single/group result
 * wrapper. The complete original service result remains available under raw. */
export function buildVariantViewFromResult(value: unknown): VariantView {
  const result = record(value);
  if (!result)
    return {
      asin: null,
      title: '',
      hasVariation: false,
      isBroken: true,
      parentAsin: null,
      brotherAsins: [],
      brand: null,
      raw: value || null,
    };
  const details = record(result.details) ?? {};
  const asin = code(details.asin);
  const brotherAsins = (
    Array.isArray(details.variations) ? details.variations : []
  )
    .map((row) => code(record(row)?.asin))
    .filter((value) => value && value !== asin);
  let parentAsin: string | null = null;
  for (const candidate of Array.isArray(details.relationships)
    ? details.relationships
    : []) {
    const row = record(candidate);
    if (!row) throw new VariantCheckError('invalid-result');
    if (Array.isArray(row.parentAsins) && row.parentAsins.length)
      parentAsin = code(row.parentAsins[0]) || null;
    if (parentAsin) break;
    if (
      (row.type === 'PARENT' || row.relationshipType === 'PARENT') &&
      (row.asin || row.parentAsin)
    )
      parentAsin = code(row.asin || row.parentAsin) || null;
    if (parentAsin) break;
  }
  const hasVariation = brotherAsins.length > 0 || !!parentAsin;
  return {
    asin,
    title: optionalText(details.title),
    hasVariation,
    isBroken:
      typeof result.isBroken === 'boolean' ? result.isBroken : !hasVariation,
    parentAsin,
    brotherAsins,
    brand: optionalText(details.brand) || null,
    raw: value,
  };
}
export function singleCheckResult(
  committed: CommittedSingleCheck,
): VariantView {
  const { asin, group, result } = committed;
  const effective = resolveAsinVariantStatus(asin, group);
  const broken = effective.isBroken === 1;
  return buildVariantViewFromResult({
    isBroken: broken,
    brokenASINs: broken
      ? [
          {
            asin: asin.asin,
            errorType:
              !result.hasVariants || effective.statusSource === 'AUTO+MANUAL'
                ? result.errorType || 'NO_VARIANTS'
                : 'MANUAL_MARKED',
            statusSource: effective.statusSource,
            manualBrokenReason: effective.manualBrokenReason || '',
          },
        ]
      : [],
    details: result,
  });
}
function observationResult(
  observation: AsinCheckObservation,
  asin: string,
  country: string,
) {
  if (observation.kind === 'deferred')
    return {
      asin,
      country,
      isBroken: false,
      isDeferred: true,
      error: observation.error,
    };
  if (observation.kind === 'failed')
    return {
      asin,
      country,
      isBroken: true,
      errorType: 'SP_API_ERROR',
      error: observation.error,
    };
  const broken = !observation.result.hasVariants;
  return {
    asin,
    country,
    isBroken: broken,
    ...(observation.result.errorType || broken
      ? { errorType: observation.result.errorType || 'NO_VARIANTS' }
      : {}),
    details: observation.result,
  };
}
export function groupCheckResult(
  committed: CommittedGroupCheck,
): VariantGroupCheckData {
  const { group, asins, observations } = committed;
  const snapshot = mapAsinQueryGroups({
    groups: [group],
    asins,
    total: 1,
    totalASINs: asins.length,
  })[0];
  const counts = { SP_API_ERROR: 0, NOT_FOUND: 0, NO_VARIANTS: 0 };
  if (!asins.length)
    return {
      isBroken: true,
      brokenASINs: [],
      brokenByType: counts,
      groupSnapshot: snapshot,
      details: { results: [] },
    };
  const rows = new Map(asins.map((row) => [row.id, row]));
  const observed = new Map(observations.map((row) => [row.asinId, row]));
  const results = observations.map((observation) => {
    const row = rows.get(observation.asinId);
    if (!row) throw new VariantCheckError('invalid-result');
    const result = observationResult(observation, row.asin, group.country);
    if (result.isBroken && 'errorType' in result)
      counts[result.errorType as keyof typeof counts]++;
    return {
      ...result,
      variantView: buildVariantViewFromResult({
        isBroken: result.isBroken,
        details: 'details' in result ? result.details : undefined,
      }),
    };
  });
  const brokenASINs = asins.flatMap((row) => {
    const effective = resolveAsinVariantStatus(row, group);
    if (effective.isBroken !== 1) return [];
    const observation = observed.get(row.id);
    if (!observation) throw new VariantCheckError('invalid-result');
    const type =
      observation.kind === 'failed'
        ? 'SP_API_ERROR'
        : observation.kind === 'checked' && !observation.result.hasVariants
        ? observation.result.errorType || 'NO_VARIANTS'
        : ['MANUAL', 'AUTO+MANUAL'].includes(effective.statusSource)
        ? 'MANUAL_MARKED'
        : observation.kind === 'deferred'
        ? undefined
        : 'NO_VARIANTS';
    return [
      {
        asin: row.asin,
        ...(type ? { errorType: type } : {}),
        statusSource: effective.statusSource,
        manualBroken: effective.manualBroken,
        manualBrokenReason: effective.manualBrokenReason || '',
        manualBrokenUpdatedAt:
          effective.manualBrokenUpdatedAt?.toISOString() ?? null,
        manualBrokenUpdatedBy: effective.manualBrokenUpdatedBy,
      },
    ];
  });
  // Raw stored automatic state and effective display state are distinct fields
  // in the Legacy check snapshot. Ordinary query mapping remains unchanged.
  const groupSnapshot = {
    ...snapshot,
    is_broken: group.isBroken ? 1 : 0,
    variant_status: group.variantStatus,
    children: (snapshot.children ?? []).map((child) => {
      const row = rows.get(child.id)!;
      const observation = observed.get(child.id)!;
      return {
        ...child,
        last_check_time: row.lastCheckTime?.toISOString() ?? null,
        ...(observation.kind === 'deferred'
          ? {}
          : {
              is_broken: row.isBroken ? 1 : 0,
              variant_status: row.variantStatus,
            }),
      };
    }),
  };
  return {
    isBroken: snapshot.isBroken === 1,
    brokenASINs,
    brokenByType: counts,
    groupStatus: {
      id: group.id,
      name: group.name,
      is_broken: snapshot.isBroken,
      statusSource: snapshot.statusSource,
      manualBroken: snapshot.manualBroken || 0,
      manualBrokenReason: snapshot.manualBrokenReason || '',
      last_check_time: group.lastCheckTime?.toISOString() ?? null,
    },
    groupSnapshot,
    details: { results },
  };
}
