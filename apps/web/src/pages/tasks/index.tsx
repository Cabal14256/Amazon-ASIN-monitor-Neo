import type { TaskInfo } from '@asin-monitor/contracts';
import { ChevronDown, Download, RefreshCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { createAccess } from '../../auth/access';
import { useAuth, useIdentity } from '../../auth/context';
import { AppShell } from '../../components/app-shell';
import { Button } from '../../components/ui/button';
import {
  EmptyState,
  FilterChip,
  Progress,
  Skeleton,
  StatusBadge,
  SuccessNotice,
} from '../../components/ui/feedback';
import { Entrance, MotionProvider } from '../../components/ui/motion';
import {
  Card,
  CardContent,
  CardHeader,
  ModuleLabel,
} from '../../components/ui/surfaces';
import {
  useCancelTask,
  useTaskListQuery,
  useTaskQuery,
} from '../../hooks/tasks';
import { ApiError } from '../../lib/http';
import {
  canCancelTask,
  canOpenTaskDetail,
  hasMoreTaskErrors,
  hasTaskDownload,
  taskDate,
  taskErrorOverflowMessage,
  taskErrors,
  taskProgress,
  taskResult,
  taskStatus,
  taskSummary,
  taskWarnings,
} from './task-display';

const errorMessage = (error: unknown) =>
  error instanceof ApiError ? error.message : '暂时无法读取任务，请稍后重试。';

function ErrorNotice({
  title,
  error,
  retry,
}: {
  title: string;
  error: unknown;
  retry: () => void;
}) {
  return (
    <div
      role="alert"
      className="rounded-control border border-status-danger/25 bg-status-danger-soft p-5 text-status-danger"
    >
      <h3 className="font-semibold">{title}</h3>
      <p className="mt-2 text-sm">{errorMessage(error)}</p>
      <Button variant="secondary" size="small" className="mt-4" onClick={retry}>
        重试加载
      </Button>
    </div>
  );
}

function DownloadAction({
  task,
  onDownload,
  pending,
  disabled,
}: {
  task: TaskInfo;
  onDownload: () => void;
  pending: boolean;
  disabled: boolean;
}) {
  return (
    <Button
      variant="secondary"
      size="small"
      pending={pending}
      disabled={disabled}
      onClick={onDownload}
    >
      <Download aria-hidden="true" className="size-4" />
      下载{task.taskType === 'import' ? '报告' : '结果'}
    </Button>
  );
}

function TaskDetails({
  task,
  canReadASIN,
}: {
  task: TaskInfo;
  canReadASIN: boolean;
}) {
  const result = taskResult(task);
  const warnings = taskWarnings(task);
  const errors = taskErrors(task);
  const counts = [
    ['总计', result?.total],
    ['成功', result?.successCount],
    ['失败', result?.failedCount],
    ['缺失', result?.missingCount],
    ['跳过', result?.skippedCount],
  ].filter(
    (row): row is [string, number] =>
      typeof row[1] === 'number' && Number.isFinite(row[1]),
  );
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="min-w-0 break-words text-lg font-bold">
          {task.title || task.taskType}
        </h3>
        <StatusBadge status={taskStatus(task.status).badge}>
          {taskStatus(task.status).label}
        </StatusBadge>
      </div>
      <p className="neo-mono break-all text-xs text-muted-foreground">
        {task.taskId}
      </p>
      <Progress value={taskProgress(task)} label="任务进度" />
      <dl className="grid gap-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <dt className="text-xs text-muted-foreground">类型</dt>
          <dd className="mt-1 break-words">
            {task.taskSubType
              ? `${task.taskType} / ${task.taskSubType}`
              : task.taskType}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">创建时间</dt>
          <dd className="mt-1">{taskDate(task.createdAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">更新时间</dt>
          <dd className="mt-1">{taskDate(task.updatedAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">完成时间</dt>
          <dd className="mt-1">{taskDate(task.completedAt)}</dd>
        </div>
      </dl>
      <div className="rounded-control bg-muted/55 p-4 text-sm">
        <p className="text-xs font-semibold text-muted-foreground">结果摘要</p>
        <p className="mt-2 break-words">{taskSummary(task)}</p>
      </div>
      {result?.verificationPassed === false && (
        <p
          role="alert"
          className="rounded-control bg-status-warning-soft p-3 text-sm text-status-warning"
        >
          后台结果校验未通过，请查看错误明细。
        </p>
      )}
      {counts.length > 0 && (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {counts.map(([label, value]) => (
            <div
              key={label}
              className="rounded-control border border-border p-3"
            >
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="neo-mono mt-1 font-semibold">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {warnings.length > 0 && (
        <section
          aria-label="任务警告"
          className="rounded-control bg-status-warning-soft p-4 text-sm text-status-warning"
        >
          <h4 className="font-semibold">任务警告</h4>
          <ul className="mt-2 list-inside list-disc space-y-1">
            {warnings.map((item, index) => (
              <li key={index} className="break-words">
                {item}
              </li>
            ))}
          </ul>
          {Array.isArray(result?.warnings) &&
            result.warnings.length > warnings.length && (
              <p className="mt-2 text-xs">仅展示前 20 项。</p>
            )}
        </section>
      )}
      {errors.length > 0 && (
        <section
          aria-label="任务错误"
          className="rounded-control border border-status-danger/25 p-4 text-sm"
        >
          <h4 className="font-semibold text-status-danger">错误明细</h4>
          <ul className="mt-2 divide-y divide-border">
            {errors.map((item, index) => (
              <li key={index} className="py-2">
                <strong>{item.label}</strong>
                <span className="ml-2 break-words">{item.message}</span>
              </li>
            ))}
          </ul>
          {hasMoreTaskErrors(task, errors.length) ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {taskErrorOverflowMessage(task, canReadASIN)}
            </p>
          ) : null}
        </section>
      )}
      {result &&
        errors.length === 0 &&
        warnings.length === 0 &&
        counts.length === 0 && (
          <p className="text-xs text-muted-foreground">
            {hasTaskDownload(task, canReadASIN)
              ? '当前结果没有可展示的结构化摘要；可通过下载入口获取完整结果。'
              : '当前结果没有可展示的结构化摘要。'}
          </p>
        )}
    </div>
  );
}

export default function TaskCenterPage() {
  const { runtime } = useAuth();
  const identity = useIdentity();
  const canReadASIN =
    identity.status === 'authenticated' &&
    createAccess(identity.identity).canReadASIN;
  const [filter, setFilter] = useState<'all' | 'active'>('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    revision: number;
    text: string;
  } | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [downloadId, setDownloadId] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const tasks = useTaskListQuery(runtime, { status: filter, limit: 100 }, true);
  const list = tasks.data;
  const selectedTask = list?.find((task) => task.taskId === selectedId);
  const canShowSelected =
    selectedId === null ||
    (selectedTask !== undefined &&
      canOpenTaskDetail(selectedTask, canReadASIN));
  const detail = useTaskQuery(
    runtime,
    selectedId ?? undefined,
    Boolean(selectedId) && canShowSelected,
  );
  const cancellation = useCancelTask(runtime);
  const activeCount =
    list?.filter((task) =>
      ['pending', 'processing', 'cancelling'].includes(task.status),
    ).length ?? 0;

  useEffect(
    () =>
      runtime.ws.onMessage((message) => {
        const text =
          message.type === 'task_complete'
            ? '有任务已完成，列表正在更新。'
            : message.type === 'task_cancelled'
            ? '有任务已取消，列表正在更新。'
            : null;
        if (text)
          setNotice((previous) => ({
            revision: (previous?.revision ?? 0) + 1,
            text,
          }));
      }),
    [runtime.ws],
  );
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (selectedId && list && !canShowSelected) setSelectedId(null);
  }, [selectedId, list, canShowSelected]);

  async function confirmCancel(taskId: string) {
    setNotice(null);
    setCancelError(null);
    try {
      await cancellation.mutateAsync(taskId);
      setConfirmId(null);
      setNotice((previous) => ({
        revision: (previous?.revision ?? 0) + 1,
        text: '已发送取消请求，状态将由服务器更新。',
      }));
    } catch (error) {
      setCancelError(errorMessage(error));
      void tasks.refetch();
      if (selectedId === taskId) void detail.refetch();
    }
  }

  async function downloadTask(task: TaskInfo) {
    if (downloadId || !hasTaskDownload(task, canReadASIN)) return;
    setDownloadId(task.taskId);
    setDownloadError(null);
    try {
      const blob = await runtime.tasks.download(task.taskId);
      const objectURL = URL.createObjectURL(blob);
      try {
        const link = document.createElement('a');
        link.href = objectURL;
        link.download = `${
          task.taskType === 'import' ? 'import' : 'check'
        }-result-${task.taskId}.json`;
        document.body.append(link);
        link.click();
        link.remove();
      } finally {
        // Give the browser time to begin reading the object URL after click().
        setTimeout(() => URL.revokeObjectURL(objectURL), 30_000);
      }
    } catch (error) {
      setDownloadError(errorMessage(error));
    } finally {
      setDownloadId(null);
    }
  }

  return (
    <AppShell title="任务中心">
      <div className="space-y-6">
        <section className="rounded-card bg-ink px-6 py-7 text-white sm:px-8">
          <ModuleLabel module="tasks">TASKS / 我的任务</ModuleLabel>
          <div className="mt-4 flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-3xl font-black tracking-tight">任务中心</h1>
              <p className="mt-3 max-w-xl text-sm leading-6 text-white/65">
                查看本人任务的实时进度、结果和安全取消状态。任务通知到达后自动刷新，断线时定时补读。
              </p>
            </div>
            <Button
              variant="secondary"
              size="small"
              pending={tasks.isFetching}
              onClick={() => {
                void tasks.refetch();
              }}
            >
              <RefreshCw aria-hidden="true" />
              刷新
            </Button>
          </div>
        </section>

        {notice && (
          <MotionProvider>
            <Entrance key={notice.revision}>
              <SuccessNotice>{notice.text}</SuccessNotice>
            </Entrance>
          </MotionProvider>
        )}
        {cancelError && (
          <p
            role="alert"
            className="rounded-control bg-status-danger-soft p-4 text-sm text-status-danger"
          >
            取消失败：{cancelError}
          </p>
        )}
        {downloadError && (
          <p
            role="alert"
            className="rounded-control bg-status-danger-soft p-4 text-sm text-status-danger"
          >
            下载失败：{downloadError}
          </p>
        )}

        <Card>
          <CardHeader
            title="我的任务"
            description={
              list
                ? `当前筛选返回 ${list.length} 条 · 其中进行中 ${activeCount} 条，最多显示最近 100 条`
                : '只读取当前账号的任务'
            }
            action={
              <div
                className="flex flex-wrap gap-2"
                role="group"
                aria-label="任务筛选"
              >
                {(['all', 'active'] as const).map((value) => (
                  <FilterChip
                    key={value}
                    selected={filter === value}
                    onClick={() => {
                      setFilter(value);
                      setSelectedId(null);
                      setConfirmId(null);
                    }}
                  >
                    {value === 'all' ? '全部任务' : '进行中'}
                  </FilterChip>
                ))}
              </div>
            }
          />
          <CardContent className="space-y-4">
            {tasks.isPending && (
              <div aria-label="正在加载任务" className="space-y-3">
                <Skeleton className="h-32" />
                <Skeleton className="h-32" />
              </div>
            )}
            {!list && tasks.isError && (
              <ErrorNotice
                title="任务列表暂不可用"
                error={tasks.error}
                retry={() => {
                  void tasks.refetch();
                }}
              />
            )}
            {list && (
              <>
                {tasks.isError && (
                  <p
                    role="status"
                    className="rounded-control bg-status-warning-soft p-3 text-sm text-status-warning"
                  >
                    刷新失败，当前展示上一次成功读取的任务。
                  </p>
                )}
                {list.length === 0 ? (
                  <EmptyState
                    title="暂无任务"
                    description="当前筛选下没有任务。可切换筛选或稍后刷新。"
                  />
                ) : (
                  <ul className="divide-y divide-border">
                    {list.map((task) => {
                      const status = taskStatus(task.status);
                      const selected = selectedId === task.taskId;
                      const confirming = confirmId === task.taskId;
                      return (
                        <li
                          key={task.taskId}
                          className="space-y-4 py-5 first:pt-0 last:pb-0"
                        >
                          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(160px,1fr)_minmax(0,1fr)_auto] lg:items-center">
                            <div className="min-w-0">
                              <div className="flex flex-wrap items-center gap-2">
                                <h3 className="break-words font-semibold">
                                  {task.title || task.taskType}
                                </h3>
                                <StatusBadge status={status.badge}>
                                  {status.label}
                                </StatusBadge>
                              </div>
                              <p className="neo-mono mt-1 break-all text-xs text-muted-foreground">
                                {task.taskId}
                              </p>
                              <p className="mt-1 text-xs text-muted-foreground">
                                {task.taskSubType
                                  ? `${task.taskType} / ${task.taskSubType}`
                                  : task.taskType}{' '}
                                · 更新于 {taskDate(task.updatedAt)}
                              </p>
                            </div>
                            <Progress
                              value={taskProgress(task)}
                              label={`${task.title || task.taskType}进度`}
                            />
                            <p className="min-w-0 break-words text-sm text-muted-foreground">
                              {taskSummary(task)}
                            </p>
                            <div className="flex flex-wrap gap-2 lg:justify-end">
                              {canOpenTaskDetail(task, canReadASIN) ? (
                                <Button
                                  variant="secondary"
                                  size="small"
                                  aria-expanded={selected}
                                  onClick={() => {
                                    setSelectedId(
                                      selected ? null : task.taskId,
                                    );
                                    setConfirmId(null);
                                  }}
                                >
                                  {selected ? '收起' : '详情'}
                                  <ChevronDown
                                    aria-hidden="true"
                                    className={selected ? 'rotate-180' : ''}
                                  />
                                </Button>
                              ) : (
                                <span className="self-center text-xs text-muted-foreground">
                                  检查结果需 ASIN 读取权限
                                </span>
                              )}
                              {hasTaskDownload(task, canReadASIN) && (
                                <DownloadAction
                                  task={task}
                                  pending={downloadId === task.taskId}
                                  disabled={downloadId !== null}
                                  onDownload={() => {
                                    void downloadTask(task);
                                  }}
                                />
                              )}
                              {canCancelTask(task) && (
                                <Button
                                  variant="destructive"
                                  size="small"
                                  onClick={() => {
                                    setConfirmId(
                                      confirming ? null : task.taskId,
                                    );
                                    setCancelError(null);
                                  }}
                                  disabled={cancellation.isPending}
                                >
                                  {confirming ? '返回' : '取消任务'}
                                </Button>
                              )}
                            </div>
                          </div>
                          {confirming && canCancelTask(task) && (
                            <div className="flex flex-wrap items-center justify-between gap-3 rounded-control bg-status-warning-soft p-4 text-sm">
                              <p>
                                确认取消“{task.title || task.taskType}
                                ”？运行中的任务会在当前批次结束后安全停止。
                              </p>
                              <div className="flex gap-2">
                                <Button
                                  variant="ghost"
                                  size="small"
                                  onClick={() => setConfirmId(null)}
                                >
                                  <X aria-hidden="true" />
                                  保留任务
                                </Button>
                                <Button
                                  variant="destructive"
                                  size="small"
                                  pending={cancellation.isPending}
                                  onClick={() => {
                                    void confirmCancel(task.taskId);
                                  }}
                                >
                                  确认取消
                                </Button>
                              </div>
                            </div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </>
            )}
          </CardContent>
        </Card>

        {selectedId && canShowSelected && (
          <Card aria-label="任务详情">
            <CardHeader
              title="任务详情"
              description="详情始终从服务器按当前登录身份读取。"
              action={
                <Button
                  variant="ghost"
                  size="small"
                  onClick={() => setSelectedId(null)}
                >
                  关闭
                </Button>
              }
            />
            <CardContent>
              {detail.isPending && (
                <div aria-label="正在加载任务详情" className="space-y-3">
                  <Skeleton className="h-10 w-1/2" />
                  <Skeleton className="h-32" />
                </div>
              )}
              {!detail.data && detail.isError && (
                <ErrorNotice
                  title="任务详情暂不可用"
                  error={detail.error}
                  retry={() => {
                    void detail.refetch();
                  }}
                />
              )}
              {detail.data && (
                <>
                  {detail.isError && (
                    <p
                      role="status"
                      className="mb-4 rounded-control bg-status-warning-soft p-3 text-sm text-status-warning"
                    >
                      详情刷新失败，当前展示上一次成功读取的内容。
                    </p>
                  )}
                  <TaskDetails task={detail.data} canReadASIN={canReadASIN} />
                  {hasTaskDownload(detail.data, canReadASIN) && (
                    <div className="mt-5">
                      <DownloadAction
                        task={detail.data}
                        pending={downloadId === detail.data.taskId}
                        disabled={downloadId !== null}
                        onDownload={() => {
                          void downloadTask(detail.data);
                        }}
                      />
                    </div>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </AppShell>
  );
}
