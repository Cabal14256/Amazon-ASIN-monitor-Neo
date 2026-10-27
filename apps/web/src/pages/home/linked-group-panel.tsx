import { isNeoBatchDeleteId } from '@asin-monitor/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useAuth, useIdentity } from '../../auth/context';
import { Button } from '../../components/ui/button';
import {
  EmptyState,
  Skeleton,
  StatusBadge,
} from '../../components/ui/feedback';
import { ApiError } from '../../lib/http';
import { getVariantGroup } from '../../services/asin';
import { workbenchScope } from './workbench-scope';

const KEY = ['home-linked-group'] as const;

function LinkedGroupRead({ id, scope }: { id: string; scope: string }) {
  const { runtime, identity } = useAuth();
  const live = useRef(true);
  const [page, setPage] = useState(1);
  const current = () =>
    live.current &&
    workbenchScope(identity.getSnapshot(), runtime.session.revision) === scope;
  const query = useQuery({
    queryKey: [...KEY, scope, id],
    queryFn: async ({ signal }) => {
      if (!current()) throw new ApiError('CANCELLED', '身份或权限已变化');
      const result = await getVariantGroup(runtime.http, id, signal);
      if (!current()) throw new ApiError('CANCELLED', '身份或权限已变化');
      if (result.id !== id || !Array.isArray(result.children))
        throw new ApiError(
          'INVALID_RESPONSE',
          '变体组详情与所选编号不一致或缺少子项',
        );
      return result;
    },
    retry: false,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      void runtime.queryClient.cancelQueries({ queryKey: [...KEY, scope, id] });
      runtime.queryClient.removeQueries({ queryKey: [...KEY, scope, id] });
    };
  }, [id, runtime, scope]);
  const denied =
    query.error instanceof ApiError &&
    [401, 403].includes(query.error.status ?? 0);
  const data = denied ? undefined : query.data;
  const retry = async () => {
    if (!current()) return;
    if (denied) await identity.refresh();
    if (current()) await query.refetch();
  };
  const children = data?.children ?? [];
  const pages = Math.max(1, Math.ceil(children.length / 50));
  return (
    <section
      aria-label="首页选中的变体组"
      className="rounded-card border border-border bg-card p-5"
    >
      <h2 className="text-lg font-bold">首页选中的变体组</h2>
      <p className="neo-mono mt-2 break-all text-xs text-muted-foreground">
        {id}
      </p>
      {query.isPending && (
        <Skeleton aria-label="正在读取所选组详情" className="mt-4 h-20" />
      )}
      {query.isError && (
        <div role="alert" className="mt-4 text-sm text-status-danger">
          <p>
            {query.error instanceof ApiError
              ? query.error.message
              : '所选组详情读取失败。'}
          </p>
          <Button
            className="mt-3"
            variant="secondary"
            size="small"
            onClick={() => void retry()}
          >
            重试所选组读取
          </Button>
        </div>
      )}
      {data && (
        <>
          <h3 className="mt-4 break-words font-semibold">
            {data.name || data.id}
          </h3>
          <p className="mt-2 break-words text-xs text-muted-foreground">
            {data.country} · {data.site} · {data.brand} · 已读取{' '}
            {children.length} 个子项
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            详情使用目录现有读取容量；每页 50 项仅为页面展示分页。
          </p>
          {children.length === 0 ? (
            <EmptyState
              title="此组没有 ASIN"
              description="目录详情没有返回任何子项。"
            />
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th scope="col" className="pb-2">
                      ASIN
                    </th>
                    <th scope="col" className="pb-2">
                      名称
                    </th>
                    <th scope="col" className="pb-2">
                      状态
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {children.slice((page - 1) * 50, page * 50).map((child) => (
                    <tr key={child.id} className="border-t border-border">
                      <td className="neo-mono break-all py-3 text-xs">
                        {child.asin}
                      </td>
                      <td className="max-w-80 break-words py-3">
                        {child.name || '—'}
                      </td>
                      <td className="py-3">
                        <StatusBadge
                          status={
                            child.isBroken === true || child.isBroken === 1
                              ? 'danger'
                              : child.isBroken === false || child.isBroken === 0
                              ? 'success'
                              : 'unknown'
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="mt-4 flex items-center gap-3">
            <Button
              variant="secondary"
              size="small"
              disabled={page === 1}
              onClick={() => current() && setPage((value) => value - 1)}
            >
              上一页子项
            </Button>
            <span className="text-xs text-muted-foreground">
              第 {page} / {pages} 页
            </span>
            <Button
              variant="secondary"
              size="small"
              disabled={page >= pages}
              onClick={() => current() && setPage((value) => value + 1)}
            >
              下一页子项
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

export function LinkedGroupPanel({ id }: { id?: string }) {
  const { runtime } = useAuth();
  const scope = workbenchScope(useIdentity(), runtime.session.revision);
  if (id === undefined || !scope) return null;
  if (
    !isNeoBatchDeleteId(id) ||
    /[\\/?#]/.test(id) ||
    id === '.' ||
    id === '..'
  )
    return (
      <p role="alert" className="text-sm text-status-danger">
        所选变体组编号无效，请从首页重新选择。
      </p>
    );
  return <LinkedGroupRead key={`${scope}:${id}`} scope={scope} id={id} />;
}
