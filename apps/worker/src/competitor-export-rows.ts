import type { VariantGroup } from '@asin-monitor/contracts';
import { asinExportFormat, asinExportRows } from './asin-export-rows';
import {
  VARIANT_GROUP_EXPORT_HEADER,
  VARIANT_GROUP_EXPORT_WIDTHS,
} from './variant-group-export-rows';

export const COMPETITOR_GROUP_HEADER = VARIANT_GROUP_EXPORT_HEADER.filter(
  (_, index) => index !== 3,
);
export const COMPETITOR_GROUP_WIDTHS = VARIANT_GROUP_EXPORT_WIDTHS.filter(
  (_, index) => index !== 3,
);
export const competitorAsinExportFormat = {
  header: asinExportFormat().header.filter((_, index) => index !== 3),
  widths: asinExportFormat().widths.filter((_, index) => index !== 3),
};
export function* competitorAsinExportRows(groups: readonly VariantGroup[]) {
  for (const row of asinExportRows(groups))
    yield row.filter((_, index) => index !== 3);
}
