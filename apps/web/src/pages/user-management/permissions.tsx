import { RefreshCw } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { EmptyState, Skeleton } from '../../components/ui/feedback';
import { Card, CardContent, CardHeader } from '../../components/ui/surfaces';
import { useManagement } from './context';
import { ManagementFailure } from './management-feedback';
import { useSensitiveQuery } from './use-sensitive-query';

export function PermissionPanel() {
  const { api, access } = useManagement();
  const { query, data, error } = useSensitiveQuery(
    ['management', 'permissions'],
    (signal) => api.permissions(signal),
    access.canReadRole,
  );
  const groups = Object.entries(data?.grouped ?? {}).sort(([a], [b]) =>
    a.localeCompare(b, 'zh-CN'),
  );
  return (
    <Card role="tabpanel" aria-label="权限控制">
      <CardHeader
        title="权限清单"
        description="按资源分组，只读展示当前权限定义。角色授权请在角色管理中操作。"
        action={
          <Button
            variant="secondary"
            size="small"
            pending={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw aria-hidden="true" />
            刷新
          </Button>
        }
      />
      <CardContent className="space-y-5">
        {query.isPending && <Skeleton className="h-32" />}
        {!data && error && (
          <ManagementFailure error={error} retry={() => void query.refetch()} />
        )}
        {data && groups.length === 0 && (
          <EmptyState
            title="尚无权限定义"
            description="当前未配置任何权限项。"
          />
        )}
        {groups.map(([resource, permissions]) => (
          <section
            key={resource}
            className="rounded-control border border-border p-4"
          >
            <h3 className="font-semibold">{resource || '其他'}</h3>
            <ul className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {permissions.map((permission) => (
                <li
                  key={permission.id}
                  className="rounded-control bg-muted p-3 text-sm"
                >
                  <p className="font-medium">{permission.name}</p>
                  <p className="neo-mono mt-1 break-all text-xs text-muted-foreground">
                    {permission.code}
                  </p>
                  {permission.description && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {permission.description}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </CardContent>
    </Card>
  );
}
