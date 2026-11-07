import { TaskExportControls } from '../../components/task-export-controls';
import type { CatalogQuery } from './catalog-types';

export function PrimaryAsinExportControls({
  query,
  disabled,
}: {
  query: CatalogQuery;
  disabled: boolean;
}) {
  return (
    <TaskExportControls
      namespace="primary-asin-export"
      disabled={disabled}
      choices={[
        {
          operation: 'asin',
          label: '导出 ASIN',
          params: {
            keyword: query.keyword,
            country: query.country,
            variantStatus: query.variantStatus,
          },
        },
      ]}
    />
  );
}
