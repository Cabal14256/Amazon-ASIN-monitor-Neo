import type { BatchCreateAsinsData } from '@asin-monitor/contracts';
import { useState } from 'react';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader } from '../../components/ui/surfaces';

const PAGE_SIZE = 50;

export function AsinBatchCreateResult({
  result,
  groupName,
  dismiss,
}: {
  result: BatchCreateAsinsData;
  groupName: string;
  dismiss: () => void;
}) {
  const [failedOnly, setFailedOnly] = useState(false);
  const [page, setPage] = useState(1);
  const rows = failedOnly
    ? result.results.filter((row) => !row.success)
    : result.results;
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  return (
    <Card aria-label="批量添加结果">
      <CardHeader
        title="批量添加结果"
        description={`变体组「${groupName}」 · 共 ${result.total} 个，成功 ${result.successCount} 个，失败 ${result.failedCount} 个。`}
        action={
          <Button variant="ghost" size="small" onClick={dismiss}>
            关闭结果
          </Button>
        }
      />
      <CardContent className="space-y-4">
        <p role="status" className="text-sm">
          {result.failedCount
            ? '失败项可逐项核对原因，已成功的编码无需重新提交。'
            : '本次所有 ASIN 已创建成功。'}
        </p>
        {result.failedCount > 0 && (
          <Button
            variant="secondary"
            size="small"
            aria-pressed={failedOnly}
            onClick={() => {
              setFailedOnly((value) => !value);
              setPage(1);
            }}
          >
            {failedOnly ? '查看全部结果' : '仅查看失败项'}
          </Button>
        )}
        <ol aria-label="逐项添加结果" className="divide-y divide-border">
          {rows
            .slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)
            .map((row) => (
              <li
                key={row.index}
                className="flex flex-wrap gap-x-4 gap-y-2 py-3 text-sm"
              >
                <span className="text-muted-foreground">
                  第 {row.index + 1} 项
                </span>
                <strong className="neo-mono break-all">{row.asin}</strong>
                <span
                  className={
                    row.success ? 'text-status-success' : 'text-status-danger'
                  }
                >
                  {row.success ? '成功' : '失败'}
                </span>
                {row.message && (
                  <span className="w-full break-words text-muted-foreground">
                    {row.message}
                  </span>
                )}
              </li>
            ))}
        </ol>
        {pages > 1 && (
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <span>
              第 {current} / {pages} 页 · 共 {rows.length} 项
            </span>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="small"
                disabled={current === 1}
                onClick={() => setPage(current - 1)}
              >
                上一页
              </Button>
              <Button
                variant="secondary"
                size="small"
                disabled={current === pages}
                onClick={() => setPage(current + 1)}
              >
                下一页
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
