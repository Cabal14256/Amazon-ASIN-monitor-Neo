import type { FeishuConfig, SpApiDisplayConfig } from '@asin-monitor/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  RefreshCw,
  Save,
  Settings2,
  ShieldCheck,
  Webhook,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { createAccess } from '../../auth/access';
import { useAuth, useIdentity } from '../../auth/context';
import { AppShell } from '../../components/app-shell';
import { Button } from '../../components/ui/button';
import {
  EmptyState,
  Skeleton,
  StatusBadge,
} from '../../components/ui/feedback';
import { Field, Input } from '../../components/ui/field';
import { Card, CardContent, CardHeader } from '../../components/ui/surfaces';
import { formatBeijing } from '../../lib/beijingTime';
import { ApiError } from '../../lib/http';
import { SettingsApi } from '../../services/settings';

type Tab = 'sp-api' | 'status' | 'feishu' | 'backup';
type Notice = { tone: 'success' | 'error'; message: string };

const BOOLEAN_KEYS = new Set([
  'COMPETITOR_MONITOR_ENABLED',
  'SP_API_USE_AWS_SIGNATURE',
  'ENABLE_HTML_SCRAPER_FALLBACK',
  'ENABLE_LEGACY_CLIENT_FALLBACK',
]);
const NUMBER_KEYS = new Set([
  'MONITOR_MAX_CONCURRENT_GROUP_CHECKS',
  'MONITOR_US_SCHEDULE_MINUTES',
  'MONITOR_EU_SCHEDULE_MINUTES',
]);
const GROUPS = [
  {
    title: 'US 区域 LWA',
    keys: [
      'SP_API_US_LWA_CLIENT_ID',
      'SP_API_US_LWA_CLIENT_SECRET',
      'SP_API_US_REFRESH_TOKEN',
    ],
  },
  {
    title: 'EU 区域 LWA',
    keys: [
      'SP_API_EU_LWA_CLIENT_ID',
      'SP_API_EU_LWA_CLIENT_SECRET',
      'SP_API_EU_REFRESH_TOKEN',
    ],
  },
  {
    title: 'AWS 与签名',
    keys: [
      'SP_API_ACCESS_KEY_ID',
      'SP_API_SECRET_ACCESS_KEY',
      'SP_API_ROLE_ARN',
      'SP_API_USE_AWS_SIGNATURE',
    ],
  },
  {
    title: '监控与备用来源',
    keys: [
      'MONITOR_MAX_CONCURRENT_GROUP_CHECKS',
      'MONITOR_US_SCHEDULE_MINUTES',
      'MONITOR_EU_SCHEDULE_MINUTES',
      'COMPETITOR_MONITOR_ENABLED',
      'ENABLE_HTML_SCRAPER_FALLBACK',
      'ENABLE_LEGACY_CLIENT_FALLBACK',
    ],
  },
] as const;

function failureMessage(error: unknown) {
  return error instanceof ApiError ? error.message : '操作失败，请稍后重试。';
}

function isEnabled(value: FeishuConfig['enabled'] | undefined) {
  return value === true || value === 1;
}

function webhookValue(row: FeishuConfig) {
  return row.webhookUrl ?? row.webhook_url ?? '';
}

function displayDate(value: string | null | undefined) {
  return value ? formatBeijing(value) : '—';
}

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
      <div className="flex items-start gap-3">
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0" />
        <div>
          <p className="font-semibold">{title}</p>
          <p className="mt-1 text-sm">{failureMessage(error)}</p>
          <Button
            variant="secondary"
            size="small"
            className="mt-4"
            onClick={retry}
          >
            <RefreshCw aria-hidden="true" />
            重试加载
          </Button>
        </div>
      </div>
    </div>
  );
}

function ConfigField({
  row,
  value,
  canWrite,
  onChange,
}: {
  row: SpApiDisplayConfig;
  value: string;
  canWrite: boolean;
  onChange: (value: string) => void;
}) {
  const sensitive = /SECRET|TOKEN|KEY/i.test(row.configKey);
  const boolean = BOOLEAN_KEYS.has(row.configKey);
  const number = NUMBER_KEYS.has(row.configKey);
  return (
    <Field
      label={row.description || row.configKey}
      hint={
        sensitive
          ? canWrite
            ? '敏感值以密码控件显示；只有修改过的字段会提交。'
            : '当前账号只有读取权限，值已按服务端策略掩码。'
          : row.configKey
      }
    >
      {(control) =>
        boolean ? (
          <select
            {...control}
            value={value === 'true' || value === '1' ? 'true' : 'false'}
            disabled={!canWrite}
            onChange={(event) => onChange(event.target.value)}
            className="w-full rounded-input border border-input bg-card px-4 py-3 text-sm text-foreground focus-visible:border-ring focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60"
          >
            <option value="true">开启</option>
            <option value="false">关闭</option>
          </select>
        ) : (
          <Input
            {...control}
            type={sensitive ? 'password' : number ? 'number' : 'text'}
            inputMode={number ? 'numeric' : undefined}
            value={value}
            disabled={!canWrite}
            onChange={(event) => onChange(event.target.value)}
          />
        )
      }
    </Field>
  );
}

function SpApiPanel({
  api,
  canWrite,
  announce,
}: {
  api: SettingsApi;
  canWrite: boolean;
  announce: (message: string) => void;
}) {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<Notice | null>(null);
  const query = useQuery({
    queryKey: ['settings', 'sp-api'],
    queryFn: ({ signal }) => api.spApiConfigs(signal),
    enabled: true,
    staleTime: 30_000,
  });
  const mutation = useMutation({
    mutationFn: (
      configs: {
        configKey: string;
        configValue: string;
        description?: string;
      }[],
    ) => api.updateSpApiConfigs({ configs }),
    onSuccess: async () => {
      setChanged(new Set());
      setDrafts({});
      setNotice({ tone: 'success', message: 'SP-API 配置已保存。' });
      announce('SP-API 配置已保存');
      await query.refetch();
    },
    onError: (error) =>
      setNotice({ tone: 'error', message: failureMessage(error) }),
  });
  const rows = useMemo(() => query.data ?? [], [query.data]);
  const byKey = useMemo(
    () => new Map(rows.map((row) => [row.configKey, row])),
    [rows],
  );
  useEffect(() => {
    setDrafts((current) => {
      const next = { ...current };
      for (const row of rows)
        if (!(row.configKey in next)) next[row.configKey] = row.configValue;
      return next;
    });
  }, [rows]);
  function setValue(key: string, value: string) {
    setDrafts((current) => ({ ...current, [key]: value }));
    setChanged((current) => new Set(current).add(key));
    setNotice(null);
  }
  function save() {
    const configs = [...changed]
      .map((key) => byKey.get(key))
      .filter((row): row is SpApiDisplayConfig => Boolean(row))
      .map((row) => ({
        configKey: row.configKey,
        configValue: drafts[row.configKey] ?? row.configValue,
        description: row.description,
      }));
    if (!configs.length) return;
    mutation.mutate(configs);
  }
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="SP-API 与监控参数"
          description="凭据与运行参数由 Neo PostgreSQL 配置来源读取。敏感值不会进入浏览器缓存。"
          action={
            <Button
              size="small"
              pending={mutation.isPending}
              disabled={!canWrite || changed.size === 0}
              onClick={save}
            >
              <Save aria-hidden="true" />
              保存修改
            </Button>
          }
        />
        <CardContent>
          {notice && (
            <p
              role={notice.tone === 'error' ? 'alert' : 'status'}
              className={
                notice.tone === 'error'
                  ? 'mb-5 rounded-control bg-status-danger-soft p-4 text-sm text-status-danger'
                  : 'mb-5 rounded-control bg-status-success-soft p-4 text-sm text-status-success'
              }
            >
              {notice.message}
            </p>
          )}
          {!canWrite && (
            <p className="mb-5 rounded-control bg-status-warning-soft p-4 text-sm text-status-warning">
              当前账号只有
              `settings:read`，可以查看非敏感运行参数，但不能保存设置或读取敏感原值。
            </p>
          )}
          {query.isPending ? (
            <div className="grid gap-5 lg:grid-cols-2">
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="h-64 rounded-card" />
              ))}
            </div>
          ) : query.isError ? (
            <ErrorNotice
              title="SP-API 配置不可用"
              error={query.error}
              retry={() => void query.refetch()}
            />
          ) : rows.length === 0 ? (
            <EmptyState
              title="暂无配置"
              description="服务器没有返回可管理的 SP-API 配置。"
            />
          ) : (
            <div className="grid gap-5 lg:grid-cols-2">
              {GROUPS.map((group) => (
                <section
                  key={group.title}
                  className="rounded-control border border-border p-5"
                >
                  <h3 className="font-semibold">{group.title}</h3>
                  <div className="mt-5 space-y-5">
                    {group.keys.map((key) => {
                      const row = byKey.get(key);
                      if (!row) return null;
                      return (
                        <ConfigField
                          key={row.configKey}
                          row={row}
                          value={drafts[row.configKey] ?? row.configValue}
                          canWrite={canWrite}
                          onChange={(value) => setValue(row.configKey, value)}
                        />
                      );
                    })}
                  </div>
                </section>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader
          title="配置来源"
          description="保存成功只代表配置写入数据库；调度器和业务 Worker 是否已加载新值由各自运行状态决定。"
        />
        <CardContent className="grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground">敏感值</p>
            <p className="mt-1">由服务端按权限掩码</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">请求缓存</p>
            <p className="mt-1">所有设置读取均为 no-store</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">生效方式</p>
            <p className="mt-1">后续调用读取已提交快照</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function FeishuPanel({
  api,
  canWrite,
  announce,
}: {
  api: SettingsApi;
  canWrite: boolean;
  announce: (message: string) => void;
}) {
  const [drafts, setDrafts] = useState<
    Record<string, { webhookUrl: string; enabled: boolean }>
  >({});
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<Notice | null>(null);
  const query = useQuery({
    queryKey: ['settings', 'feishu'],
    queryFn: ({ signal }) => api.feishuConfigs(signal),
    staleTime: 30_000,
  });
  const mutation = useMutation({
    mutationFn: async (
      items: { country: string; webhookUrl: string; enabled: boolean }[],
    ) => {
      for (const item of items) await api.upsertFeishu(item);
    },
    onSuccess: async () => {
      setChanged(new Set());
      setDrafts({});
      setNotice({ tone: 'success', message: '飞书配置已保存。' });
      announce('飞书配置已保存');
      await query.refetch();
    },
    onError: (error) =>
      setNotice({ tone: 'error', message: failureMessage(error) }),
  });
  const rows = useMemo(() => query.data ?? [], [query.data]);
  const byCountry = useMemo(
    () => new Map(rows.map((row) => [row.country, row])),
    [rows],
  );
  useEffect(() => {
    setDrafts((current) => {
      const next = { ...current };
      for (const country of ['US', 'EU']) {
        const row = byCountry.get(country);
        if (row && !next[country])
          next[country] = {
            webhookUrl: webhookValue(row),
            enabled: isEnabled(row.enabled),
          };
      }
      return next;
    });
  }, [byCountry]);
  function update(
    country: string,
    patch: Partial<{ webhookUrl: string; enabled: boolean }>,
  ) {
    setDrafts((current) => ({
      ...current,
      [country]: {
        ...(current[country] ?? { webhookUrl: '', enabled: false }),
        ...patch,
      },
    }));
    setChanged((current) => new Set(current).add(country));
    setNotice(null);
  }
  function save() {
    const items = [...changed]
      .map((country) => {
        const row = drafts[country];
        return row ? { country, ...row } : undefined;
      })
      .filter(
        (
          item,
        ): item is { country: string; webhookUrl: string; enabled: boolean } =>
          Boolean(item),
      );
    if (items.some((item) => !item.webhookUrl.trim())) {
      setNotice({
        tone: 'error',
        message: '启用或保存飞书配置前必须填写 Webhook 地址。',
      });
      return;
    }
    if (items.length) mutation.mutate(items);
  }
  return (
    <Card>
      <CardHeader
        title="飞书通知"
        description="按国家站点保存通知 Webhook。只读账号只能查看掩码，不能提交或切换状态。"
        action={
          <Button
            size="small"
            pending={mutation.isPending}
            disabled={!canWrite || changed.size === 0}
            onClick={save}
          >
            <Save aria-hidden="true" />
            保存修改
          </Button>
        }
      />
      <CardContent>
        {notice && (
          <p
            role={notice.tone === 'error' ? 'alert' : 'status'}
            className={
              notice.tone === 'error'
                ? 'mb-5 rounded-control bg-status-danger-soft p-4 text-sm text-status-danger'
                : 'mb-5 rounded-control bg-status-success-soft p-4 text-sm text-status-success'
            }
          >
            {notice.message}
          </p>
        )}
        {query.isPending ? (
          <div className="grid gap-5 lg:grid-cols-2">
            <Skeleton className="h-56 rounded-card" />
            <Skeleton className="h-56 rounded-card" />
          </div>
        ) : query.isError ? (
          <ErrorNotice
            title="飞书配置不可用"
            error={query.error}
            retry={() => void query.refetch()}
          />
        ) : (
          <div className="grid gap-5 lg:grid-cols-2">
            {['US', 'EU'].map((country) => {
              const row = byCountry.get(country);
              const draft = drafts[country] ?? {
                webhookUrl: '',
                enabled: false,
              };
              return (
                <section
                  key={country}
                  className="rounded-control border border-border p-5"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <h3 className="font-semibold">{country} 通知</h3>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {row
                          ? `最近更新：${displayDate(
                              row.updateTime ?? row.update_time,
                            )}`
                          : '尚未创建配置'}
                      </p>
                    </div>
                    <Webhook
                      aria-hidden="true"
                      className="size-5 text-module-analytics"
                    />
                  </div>
                  <div className="mt-5 space-y-5">
                    <Field
                      label="Webhook 地址"
                      hint={
                        canWrite
                          ? '保存时只提交当前国家的修改。'
                          : '服务端已隐藏完整地址。'
                      }
                    >
                      {(control) => (
                        <Input
                          {...control}
                          type="password"
                          value={
                            canWrite
                              ? draft.webhookUrl
                              : row
                              ? '***REDACTED***'
                              : ''
                          }
                          disabled={!canWrite}
                          onChange={(event) =>
                            update(country, { webhookUrl: event.target.value })
                          }
                        />
                      )}
                    </Field>
                    <label className="flex min-h-10 items-center gap-3 text-sm">
                      <input
                        type="checkbox"
                        className="size-4 accent-ink"
                        checked={draft.enabled}
                        disabled={!canWrite}
                        onChange={(event) =>
                          update(country, { enabled: event.target.checked })
                        }
                      />
                      启用通知
                    </label>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {draft.enabled ? (
                        <StatusBadge status="success">已启用</StatusBadge>
                      ) : (
                        <StatusBadge status="warning">已停用</StatusBadge>
                      )}
                      {row && <span>配置 ID {row.id}</span>}
                    </div>
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatusPanel({ api }: { api: SettingsApi }) {
  const [hours, setHours] = useState(24);
  const quota = useQuery({
    queryKey: ['settings', 'quota'],
    queryFn: ({ signal }) => api.quota(signal),
    refetchInterval: 30_000,
  });
  const errors = useQuery({
    queryKey: ['settings', 'errors', hours],
    queryFn: ({ signal }) => api.errors(hours, signal),
    refetchInterval: 30_000,
  });
  const errorTypes = Object.entries(errors.data?.byType ?? {}).sort(
    (a, b) => b[1].count - a[1].count,
  );
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader
          title="SP-API 配额状态"
          description="状态来自当前 API 进程和共享配额存储，数值为实时快照。"
          action={
            <Button
              variant="ghost"
              size="small"
              pending={quota.isFetching}
              onClick={() => void quota.refetch()}
            >
              <RefreshCw aria-hidden="true" />
              刷新
            </Button>
          }
        />
        <CardContent>
          {quota.isPending ? (
            <div className="grid gap-5 lg:grid-cols-2">
              <Skeleton className="h-52 rounded-card" />
              <Skeleton className="h-52 rounded-card" />
            </div>
          ) : quota.isError ? (
            <ErrorNotice
              title="配额状态不可用"
              error={quota.error}
              retry={() => void quota.refetch()}
            />
          ) : (
            <div className="grid gap-5 lg:grid-cols-2">
              {(['US', 'EU'] as const).map((region) => {
                const snapshot = quota.data?.[region];
                if (!snapshot)
                  return (
                    <EmptyState
                      key={region}
                      title={`${region} 暂无状态`}
                      description="当前 API 没有返回该区域快照。"
                    />
                  );
                return (
                  <section
                    key={region}
                    className="rounded-control border border-border p-5"
                  >
                    <div className="flex items-center justify-between gap-4">
                      <h3 className="font-semibold">{region} 区域</h3>
                      <StatusBadge
                        status={snapshot.redisAvailable ? 'success' : 'warning'}
                      >
                        {snapshot.redisAvailable ? 'Redis 可用' : '内存回退'}
                      </StatusBadge>
                    </div>
                    <dl className="mt-5 grid grid-cols-2 gap-4 text-sm">
                      <div>
                        <dt className="text-xs text-muted-foreground">模式</dt>
                        <dd className="mt-1 break-words">{snapshot.mode}</dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">来源</dt>
                        <dd className="mt-1 break-words">
                          {snapshot.limitSource}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">
                          分钟剩余
                        </dt>
                        <dd className="neo-mono mt-1">
                          {snapshot.minuteTokens}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs text-muted-foreground">
                          小时剩余
                        </dt>
                        <dd className="neo-mono mt-1">{snapshot.hourTokens}</dd>
                      </div>
                    </dl>
                    <div className="mt-5 space-y-2 border-t border-border pt-4 text-xs">
                      {Object.entries(snapshot.windows).map(
                        ([name, window]) => (
                          <div
                            key={name}
                            className="flex justify-between gap-4"
                          >
                            <span className="text-muted-foreground">
                              {name}
                            </span>
                            <span className="neo-mono">
                              {window.used} / {window.limit}
                            </span>
                          </div>
                        ),
                      )}
                    </div>
                  </section>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader
          title="上游错误统计"
          description="统计范围是当前 API 进程发起的上游尝试，不代表全局所有 Worker。"
          action={
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              时间范围
              <select
                value={hours}
                onChange={(event) => setHours(Number(event.target.value))}
                className="rounded-input border border-input bg-card px-3 py-2 text-foreground"
              >
                <option value={1}>1 小时</option>
                <option value={6}>6 小时</option>
                <option value={24}>24 小时</option>
                <option value={168}>7 天</option>
              </select>
            </label>
          }
        />
        <CardContent>
          {errors.isPending ? (
            <Skeleton className="h-48 rounded-card" />
          ) : errors.isError ? (
            <ErrorNotice
              title="错误统计不可用"
              error={errors.error}
              retry={() => void errors.refetch()}
            />
          ) : errors.data ? (
            <div className="space-y-5">
              <div className="grid gap-4 sm:grid-cols-3">
                <div className="rounded-control bg-muted/60 p-4">
                  <p className="text-xs text-muted-foreground">总错误</p>
                  <p className="neo-mono mt-2 text-2xl font-black">
                    {errors.data.total}
                  </p>
                </div>
                <div className="rounded-control bg-muted/60 p-4">
                  <p className="text-xs text-muted-foreground">最近窗口</p>
                  <p className="neo-mono mt-2 text-2xl font-black">
                    {errors.data.recent.count}
                  </p>
                </div>
                <div className="rounded-control bg-muted/60 p-4">
                  <p className="text-xs text-muted-foreground">时间序列点</p>
                  <p className="neo-mono mt-2 text-2xl font-black">
                    {errors.data.timeSeries.length}
                  </p>
                </div>
              </div>
              {errorTypes.length ? (
                <div className="divide-y divide-border rounded-control border border-border">
                  {errorTypes.map(([type, bucket]) => (
                    <div
                      key={type}
                      className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm"
                    >
                      <span className="break-all">{type}</span>
                      <span className="neo-mono text-status-danger">
                        {bucket.count}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState
                  title="暂无上游错误"
                  description={`最近 ${hours} 小时没有记录到错误。`}
                />
              )}
            </div>
          ) : (
            <EmptyState
              title="暂无统计"
              description="刷新后重新读取错误统计。"
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function BackupPanel() {
  return (
    <Card>
      <CardHeader
        title="备份与恢复"
        description="数据库备份域正在单独迁移，当前 Neo API 尚未提供可执行的备份、恢复或下载端点。"
      />
      <CardContent>
        <div className="rounded-control bg-status-warning-soft p-5 text-sm text-status-warning">
          <div className="flex items-start gap-3">
            <AlertTriangle
              aria-hidden="true"
              className="mt-0.5 size-5 shrink-0"
            />
            <div>
              <p className="font-semibold">暂不可用</p>
              <p className="mt-2 leading-6">
                Legacy 备份入口继续承担现有业务。Neo 侧会在备份 API、pg_dump
                产物和 Worker
                任务链路完成后再开放此区域；当前页面不会发送未实现的请求。
              </p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function SettingsPage() {
  const { runtime, announce } = useAuth();
  const identity = useIdentity();
  const current =
    identity.status === 'authenticated' ? identity.identity : undefined;
  const access = createAccess(current);
  const api = useMemo(() => new SettingsApi(runtime.http), [runtime.http]);
  const [tab, setTab] = useState<Tab>('sp-api');
  const tabs = [
    { key: 'sp-api' as const, label: 'SP-API 与监控' },
    { key: 'status' as const, label: '配额与错误' },
    { key: 'feishu' as const, label: '飞书通知' },
    { key: 'backup' as const, label: '备份与恢复' },
  ];
  return (
    <AppShell title="系统设置">
      <div className="space-y-6">
        <section className="rounded-card bg-ink px-6 py-7 text-white sm:px-8">
          <span className="inline-flex items-center gap-2.5 text-xs font-semibold">
            <Settings2 aria-hidden="true" className="size-4 text-signal" />
            CONFIGURATION / 系统设置
          </span>
          <h1 className="mt-4 text-3xl font-black tracking-tight">系统设置</h1>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-white/65">
            集中管理
            SP-API、监控参数、飞书通知和运行状态。权限与敏感值始终由服务端重新校验。
          </p>
        </section>
        <div
          className="flex flex-wrap gap-2"
          role="tablist"
          aria-label="系统设置分区"
        >
          {tabs.map((item) => (
            <Button
              key={item.key}
              variant={tab === item.key ? 'primary' : 'secondary'}
              size="small"
              role="tab"
              aria-selected={tab === item.key}
              onClick={() => setTab(item.key)}
            >
              {item.label}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-3 rounded-control bg-muted/55 px-4 py-3 text-sm text-muted-foreground">
          <ShieldCheck
            aria-hidden="true"
            className="size-4 shrink-0 text-module-analytics"
          />
          <span>
            {access.canWriteSettings
              ? '当前账号具备 settings:write，可编辑设置。'
              : '当前账号仅可读取允许展示的设置。'}
          </span>
        </div>
        {tab === 'sp-api' && (
          <SpApiPanel
            api={api}
            canWrite={access.canWriteSettings}
            announce={announce}
          />
        )}
        {tab === 'status' && <StatusPanel api={api} />}
        {tab === 'feishu' && (
          <FeishuPanel
            api={api}
            canWrite={access.canWriteSettings}
            announce={announce}
          />
        )}
        {tab === 'backup' && <BackupPanel />}
      </div>
    </AppShell>
  );
}
