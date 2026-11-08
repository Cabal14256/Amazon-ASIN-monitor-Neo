import { parentAsinExportTaskRequestSchema } from '@asin-monitor/contracts';
import { TaskExportControls } from '../../components/task-export-controls';

export function ParentAsinExportControls({
  input,
  country,
  disabled,
}: {
  input: string;
  country: string;
  disabled: boolean;
}) {
  // The page accepts whitespace/full-width commas as separators. Preserve
  // repeated input positions; the Legacy-compatible API filters invalid tokens.
  const params = { asins: input.replace(/[\s，]+/gu, '\n'), country };
  const valid = parentAsinExportTaskRequestSchema.safeParse({
    exportType: 'parent-asin-query',
    params,
  }).success;
  return (
    <div className="space-y-2">
      <TaskExportControls
        namespace="parent-asin-export"
        disabled={disabled || !valid}
        choices={[
          {
            operation: 'parent-asin-query',
            label: '后台查询并导出 XLSX',
            params,
          },
        ]}
      />
      <p className="text-sm text-muted-foreground">
        后台按当前输入重新查询，生成含查询时间和错误信息的 11
        列工作簿；重复输入保留，一次最多 1000 条。完成后在任务中心下载。
      </p>
    </div>
  );
}
