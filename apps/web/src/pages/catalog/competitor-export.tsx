import { TaskExportControls } from '../../components/task-export-controls';
import type { CatalogQuery } from './catalog-types';
export function CompetitorExportControls({
  query,
  disabled,
}: {
  query: CatalogQuery;
  disabled: boolean;
}) {
  const params = {
    keyword: query.keyword,
    country: query.country,
    variantStatus: query.variantStatus,
  };
  return (
    <TaskExportControls
      namespace="competitor-export"
      disabled={disabled}
      choices={[
        { operation: 'competitor-asin', label: '导出竞品 ASIN', params },
        {
          operation: 'competitor-variant-group',
          label: '导出竞品变体组',
          params,
        },
      ]}
    />
  );
}
