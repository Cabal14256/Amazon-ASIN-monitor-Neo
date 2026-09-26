import type { ParentAsinQueryItem } from '@asin-monitor/contracts';
import { Download, Eraser, Play, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createAccess } from '../../auth/access';
import { useAuth, useIdentity } from '../../auth/context';
import { AppShell } from '../../components/app-shell';
import { Button } from '../../components/ui/button';
import {
  EmptyState,
  Progress,
  Skeleton,
  StatusBadge,
} from '../../components/ui/feedback';
import {
  Card,
  CardContent,
  CardHeader,
  ModuleLabel,
} from '../../components/ui/surfaces';
import { ApiError } from '../../lib/http';
import { TaskCompletionError } from '../../services/tasks';
import {
  parentQueryCsv,
  parseParentAsins,
  parseParentQueryItems,
  queryParentAsins,
  validParentAsins,
} from '../../services/parent-query';

const countries = [
  ['US', '美国'],
  ['UK', '英国'],
  ['DE', '德国'],
  ['FR', '法国'],
  ['IT', '意大利'],
  ['ES', '西班牙'],
] as const;

const errorText = (error: unknown) =>
  error instanceof ApiError || error instanceof TaskCompletionError
    ? error.message
    : '父体查询暂时不可用，请稍后重试。';

function Results({ items }: { items: ParentAsinQueryItem[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[980px] text-left text-sm">
        <thead className="border-b border-border text-xs text-muted-foreground">
          <tr>
            <th className="px-3 py-3">ASIN</th>
            <th className="px-3 py-3">父体 ASIN</th>
            <th className="px-3 py-3">父体标题</th>
            <th className="px-3 py-3">产品标题</th>
            <th className="px-3 py-3">品牌</th>
            <th className="px-3 py-3">变体数</th>
            <th className="px-3 py-3">状态</th>
            <th className="px-3 py-3">错误信息</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {items.map((item) => (
            <tr key={item.asin} className="align-top">
              <td className="neo-mono px-3 py-3 font-semibold">{item.asin}</td>
              <td className="neo-mono px-3 py-3">{item.parentAsin || '无'}</td>
              <td className="max-w-[260px] px-3 py-3">
                {item.parentTitle || '无'}
              </td>
              <td className="max-w-[260px] px-3 py-3">{item.title || '无'}</td>
              <td className="px-3 py-3">{item.brand || '无'}</td>
              <td className="neo-mono px-3 py-3">{item.variantCount}</td>
              <td className="px-3 py-3">
                {item.error ? (
                  <span title={item.error}>
                    <StatusBadge status="danger">失败</StatusBadge>
                  </span>
                ) : (
                  <StatusBadge status="success">成功</StatusBadge>
                )}
              </td>
              <td className="max-w-[260px] break-words px-3 py-3 text-status-danger">
                {item.error || '无'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function AsinParentQueryPage() {
  const { runtime } = useAuth();
  const identity = useIdentity();
  const canRead =
    identity.status === 'authenticated' &&
    createAccess(identity.identity).canReadASIN;
  const [input, setInput] = useState('');
  const [country, setCountry] = useState('US');
  const [items, setItems] = useState<ParentAsinQueryItem[]>([]);
  const [pending, setPending] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const waitController = useRef<AbortController | null>(null);

  useEffect(() => () => waitController.current?.abort(), []);

  async function runQuery() {
    const asins = validParentAsins(input);
    const invalid = parseParentAsins(input).length - asins.length;
    if (!asins.length) {
      setError('请输入至少一个有效的 10 位 ASIN。');
      return;
    }
    if (asins.length > 1000) {
      setError('一次最多查询 1000 个 ASIN。');
      return;
    }
    setPending(true);
    setError(null);
    setMessage(invalid ? `已忽略 ${invalid} 个格式无效的输入。` : null);
    setProgress(null);
    try {
      const accepted = await queryParentAsins(runtime.http, { asins, country });
      if (Array.isArray(accepted)) {
        setItems(accepted);
      } else {
        waitController.current = new AbortController();
        const task = await runtime.tasks.wait(accepted.taskId, {
          timeoutMs: 10 * 60 * 1000,
          signal: waitController.current.signal,
          onProgress: (snapshot) => setProgress(snapshot.progress),
        });
        if (!Array.isArray(task.result))
          throw new ApiError('INVALID_RESPONSE', '父体查询任务结果无效');
        setItems(parseParentQueryItems(task.result));
      }
      setMessage('查询完成。');
    } catch (cause) {
      if (cause instanceof ApiError && cause.kind === 'CANCELLED') {
        setMessage('查询任务已取消。');
      } else {
        setError(errorText(cause));
        setItems([]);
      }
    } finally {
      setPending(false);
      setProgress(null);
      waitController.current = null;
    }
  }

  function exportResults() {
    if (!items.length || pending) return;
    setError(null);
    const url = URL.createObjectURL(
      new Blob([parentQueryCsv(items)], { type: 'text/csv;charset=utf-8' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `asin-parent-query-${new Date()
      .toISOString()
      .slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
    setMessage('结果已导出。');
  }

  return (
    <AppShell title="父变体查询">
      <div className="space-y-6">
        <section className="rounded-card bg-ink px-6 py-7 text-white sm:px-8">
          <ModuleLabel module="asin">ASIN / 父变体查询</ModuleLabel>
          <h1 className="mt-4 text-3xl font-black tracking-tight">
            查找父体关系
          </h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-white/65">
            批量检查 ASIN 的父体、标题、品牌和变体数量，结果由 Neo
            检查任务统一追踪。
          </p>
        </section>
        <Card>
          <CardHeader
            title="查询条件"
            description="每行、空格或逗号输入一个 ASIN。"
            action={
              <Button
                variant="ghost"
                size="small"
                onClick={() => {
                  setInput('');
                  setItems([]);
                  setError(null);
                  setMessage(null);
                }}
                disabled={pending}
              >
                <Eraser aria-hidden="true" />
                清空
              </Button>
            }
          />
          <CardContent className="space-y-5">
            <label
              className="block text-sm font-semibold"
              htmlFor="parent-asins"
            >
              ASIN 列表
              <textarea
                id="parent-asins"
                rows={7}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                disabled={!canRead || pending}
                className="mt-2 w-full rounded-control border border-input bg-card p-3 font-mono text-sm outline-none focus-visible:border-ring"
                placeholder="B012345678\nB087654321"
              />
            </label>
            <div className="flex flex-wrap items-end gap-4">
              <label
                className="block text-sm font-semibold"
                htmlFor="parent-country"
              >
                国家/站点
                <select
                  id="parent-country"
                  value={country}
                  onChange={(event) => setCountry(event.target.value)}
                  disabled={!canRead || pending}
                  className="mt-2 min-h-11 rounded-control border border-input bg-card px-3 text-sm font-normal"
                >
                  <option value="US">美国</option>
                  {countries.slice(1).map(([code, name]) => (
                    <option key={code} value={code}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                pending={pending}
                disabled={!canRead}
                onClick={() => void runQuery()}
              >
                <Play aria-hidden="true" />
                查询父体
              </Button>
              {items.length > 0 && (
                <Button
                  variant="secondary"
                  disabled={pending}
                  onClick={exportResults}
                >
                  <Download aria-hidden="true" />
                  导出 CSV
                </Button>
              )}
            </div>
            {pending && <Progress value={progress} label="任务进度" />}
            {message && (
              <p
                role="status"
                className="rounded-control bg-status-success-soft p-3 text-sm text-status-success"
              >
                {message}
              </p>
            )}
            {error && (
              <p
                role="alert"
                className="rounded-control bg-status-danger-soft p-3 text-sm text-status-danger"
              >
                {error}
              </p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader
            title="查询结果"
            description={
              items.length ? `共 ${items.length} 条` : '提交查询后显示结果。'
            }
            action={
              items.length > 0 ? (
                <Button
                  variant="ghost"
                  size="small"
                  onClick={() => void runQuery()}
                  disabled={pending}
                >
                  <RefreshCw aria-hidden="true" />
                  重新查询
                </Button>
              ) : undefined
            }
          />
          <CardContent>
            {pending && items.length === 0 ? (
              <Skeleton className="h-48" />
            ) : items.length ? (
              <Results items={items} />
            ) : (
              <EmptyState
                title="暂无查询结果"
                description="输入 ASIN 后开始查询父体关系。"
              />
            )}
          </CardContent>
        </Card>
      </div>
    </AppShell>
  );
}
