import { Button } from '../../components/ui/button';
import { managementError } from './management-data';

export function ManagementFailure({
  error,
  retry,
  title = '数据暂不可用',
}: {
  error: unknown;
  retry: () => void;
  title?: string;
}) {
  return (
    <div
      role="alert"
      className="rounded-control border border-status-danger/25 bg-status-danger-soft p-5 text-status-danger"
    >
      <p className="font-semibold">{title}</p>
      <p className="mt-2 text-sm">{managementError(error)}</p>
      <Button variant="secondary" size="small" className="mt-4" onClick={retry}>
        重试加载
      </Button>
    </div>
  );
}
