import {
  ArrowDownToLine,
  ArrowRight,
  ArrowUpRight,
  Boxes,
  Check,
  CircleDot,
  Command,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/button';
import {
  EmptyState,
  FilterChip,
  Progress,
  Skeleton,
  StatusBadge,
  SuccessNotice,
} from '../../components/ui/feedback';
import { Field, Input, Textarea } from '../../components/ui/field';
import {
  AnimatedNumber,
  Entrance,
  MotionProvider,
  SuccessMark,
  UpdatePulse,
} from '../../components/ui/motion';
import {
  Card,
  CardContent,
  CardHeader,
  ModuleLabel,
} from '../../components/ui/surfaces';

/** Development-only component specimens, never a source of business data. */
export default function DesignSystemPreview() {
  const [country, setCountry] = useState('全部站点');
  const [updates, setUpdates] = useState(0);
  const [progress, setProgress] = useState<number | undefined>(36);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(false);
  function save(event: FormEvent) {
    event.preventDefault();
    const valid = Boolean(name.trim());
    setError(valid ? undefined : '请输入变体组名称');
    setSaved(valid);
  }
  return (
    <MotionProvider>
      <a
        href="#preview-content"
        className="sr-only rounded-pill bg-signal px-4 py-3 focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-50"
      >
        跳到组件预览
      </a>
      <div className="mx-auto min-h-screen max-w-[1440px] px-5 py-6 sm:px-10 lg:px-14">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-6">
          <div className="flex items-center gap-3">
            <div className="flex size-10 items-center justify-center rounded-control bg-ink text-signal">
              <Boxes aria-hidden="true" className="size-5" />
            </div>
            <span className="text-sm font-bold tracking-tight">
              ASIN MONITOR{' '}
              <span className="ml-1 font-normal text-muted-foreground">
                / Neo
              </span>
            </span>
          </div>
          <span className="rounded-pill border border-border px-3 py-1.5 text-xs text-muted-foreground">
            开发预览 · 虚构示例
          </span>
        </header>
        <main id="preview-content" tabIndex={-1}>
          <div className="flex flex-wrap items-end justify-between gap-6 py-10 sm:py-12">
            <div>
              <p className="neo-mono mb-3 text-xs uppercase tracking-[.2em] text-muted-foreground">
                Interface / Foundation 01
              </p>
              <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
                明快
                <span className="ml-2 inline-block -rotate-2 rounded-chip bg-signal px-2 py-1">
                  作业台
                </span>
              </h1>
              <p className="mt-4 max-w-lg text-sm leading-7 text-muted-foreground">
                把复杂的监控，变成清晰的日常。
                <br />
                同一套组件，连接数据、状态与每一次操作。
              </p>
            </div>
            <div className="flex flex-wrap gap-5 pb-1">
              <ModuleLabel module="asin">ASIN</ModuleLabel>
              <ModuleLabel module="monitor">监控</ModuleLabel>
              <ModuleLabel module="analytics">分析</ModuleLabel>
              <ModuleLabel module="tasks">任务</ModuleLabel>
              <ModuleLabel module="competitor">竞品</ModuleLabel>
            </div>
          </div>
          <Entrance>
            <section
              className="grid gap-8 rounded-card bg-ink p-6 text-white sm:p-8 lg:grid-cols-[1fr_auto]"
              aria-label="数字与状态反馈示例"
            >
              <div>
                <div className="mb-7 flex items-center gap-2 text-xs text-white/65">
                  <CircleDot
                    aria-hidden="true"
                    className="size-3.5 text-signal"
                  />
                  监控状态 · 示例数据
                </div>
                <div className="grid grid-cols-2 gap-6 sm:grid-cols-3">
                  <div>
                    <p className="mb-2 text-xs text-white/60">管理中的 ASIN</p>
                    <AnimatedNumber
                      value={1284 + updates * 12}
                      className="text-3xl font-medium text-signal sm:text-4xl"
                    />
                  </div>
                  <div>
                    <p className="mb-2 text-xs text-white/60">今日检查</p>
                    <AnimatedNumber
                      value={8640 + updates * 24}
                      className="text-3xl font-medium sm:text-4xl"
                    />
                  </div>
                  <div>
                    <p className="mb-2 text-xs text-white/60">需要关注</p>
                    <AnimatedNumber
                      value={8}
                      className="text-3xl font-medium sm:text-4xl"
                    />
                  </div>
                </div>
              </div>
              <div className="flex flex-col justify-end gap-3 lg:items-end">
                <Button onClick={() => setUpdates((value) => value + 1)}>
                  <RefreshCw aria-hidden="true" />
                  模拟数据更新
                </Button>
                <span className="text-xs text-white/60">
                  数字平滑更新，遵循系统动效偏好
                </span>
              </div>
            </section>
          </Entrance>
          <div className="mt-6 grid items-start gap-6 lg:grid-cols-[1.25fr_1fr]">
            <div className="space-y-6">
              <Entrance index={1}>
                <Card>
                  <CardHeader
                    title="操作与筛选"
                    description="主操作突出，次操作安静；键盘焦点始终可见。"
                  />
                  <CardContent>
                    <div className="flex flex-wrap items-center gap-3">
                      <Button>
                        <Plus aria-hidden="true" />
                        新增 ASIN
                      </Button>
                      <Button variant="secondary">
                        <ArrowDownToLine aria-hidden="true" />
                        导出记录
                      </Button>
                      <Button variant="ghost">
                        查看详情
                        <ArrowUpRight aria-hidden="true" />
                      </Button>
                    </div>
                    <div className="mt-5 flex flex-wrap items-center gap-3">
                      <Button pending>正在保存</Button>
                      <Button disabled variant="secondary">
                        暂无权限
                      </Button>
                      <Button variant="destructive" size="small">
                        删除记录
                      </Button>
                      <Button
                        variant="secondary"
                        size="icon"
                        aria-label="命令面板示例"
                      >
                        <Command aria-hidden="true" />
                      </Button>
                    </div>
                    <div className="my-6 border-t border-border" />
                    <div className="mb-3 text-xs text-muted-foreground">
                      站点筛选 · 点击切换
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {['全部站点', 'US 美国', 'UK 英国', 'DE 德国'].map(
                        (label) => (
                          <FilterChip
                            key={label}
                            selected={country === label}
                            onClick={() => setCountry(label)}
                          >
                            {label}
                          </FilterChip>
                        ),
                      )}
                    </div>
                  </CardContent>
                </Card>
              </Entrance>
              <Entrance index={2}>
                <Card>
                  <CardHeader
                    title="状态与实时反馈"
                    description="文字和图标共同表达状态，颜色不作为唯一线索。"
                  />
                  <CardContent>
                    <div className="flex flex-wrap gap-2">
                      {(
                        [
                          'success',
                          'danger',
                          'warning',
                          'running',
                          'pending',
                          'unknown',
                        ] as const
                      ).map((status) => (
                        <StatusBadge key={status} status={status} />
                      ))}
                    </div>
                    <div className="mt-6 divide-y divide-border rounded-control border border-border">
                      {['B0EXAMPLE01', 'B0EXAMPLE02', 'B0EXAMPLE03'].map(
                        (asin, index) => (
                          <UpdatePulse
                            key={asin}
                            revision={
                              index === 0 && updates > 0 ? updates : undefined
                            }
                            className="rounded-control"
                          >
                            <div className="neo-row flex flex-wrap items-center gap-3 px-4 py-4 text-sm">
                              <span className="neo-mono mr-auto">{asin}</span>
                              <StatusBadge
                                status={index === 1 ? 'warning' : 'success'}
                              />
                              <ArrowRight
                                aria-hidden="true"
                                className="neo-row-arrow size-4 text-muted-foreground"
                              />
                            </div>
                          </UpdatePulse>
                        ),
                      )}
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground">
                      点击上方“模拟数据更新”，首行会反馈本次变化。
                    </p>
                  </CardContent>
                </Card>
              </Entrance>
              <Entrance index={3}>
                <Card>
                  <CardHeader
                    title="进度与加载"
                    description="已知进度与等待进度分别表达，不模拟业务完成。"
                    action={
                      <Button
                        size="small"
                        variant="ghost"
                        onClick={() => setLoading((value) => !value)}
                      >
                        {loading ? '显示进度' : '预览骨架'}
                      </Button>
                    }
                  />
                  <CardContent>
                    {loading ? (
                      <div
                        role="status"
                        aria-label="正在加载任务列表"
                        className="space-y-4"
                      >
                        <Skeleton className="h-4 w-1/3" />
                        <Skeleton className="h-3.5 w-full" />
                        <Skeleton className="h-4 w-2/3" />
                      </div>
                    ) : (
                      <div className="space-y-5">
                        <Progress value={progress} label="导出任务 · 示例" />
                        <Progress label="正在获取任务状态" />
                        <div className="flex flex-wrap gap-2">
                          <Button
                            size="small"
                            variant="secondary"
                            onClick={() =>
                              setProgress((value) =>
                                Math.min(100, (value ?? 0) + 16),
                              )
                            }
                          >
                            推进示例
                          </Button>
                          <Button
                            size="small"
                            variant="ghost"
                            onClick={() => setProgress(0)}
                          >
                            重置
                          </Button>
                        </div>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </Entrance>
            </div>
            <div className="space-y-6">
              <Entrance index={2}>
                <Card>
                  <CardHeader
                    title="清晰的表单"
                    description="标签、帮助与错误关联到同一个输入控件。"
                  />
                  <CardContent>
                    <form noValidate onSubmit={save} className="space-y-5">
                      <Field
                        label="变体组名称"
                        hint="使用容易辨认的名称，便于日常查找。"
                        error={error}
                        required
                      >
                        {(control) => (
                          <Input
                            {...control}
                            value={name}
                            onChange={(event) => {
                              setName(event.target.value);
                              setSaved(false);
                              if (error) setError(undefined);
                            }}
                            placeholder="例如：夏季家居系列"
                          />
                        )}
                      </Field>
                      <Field label="备注" hint="可选，用于补充团队协作信息。">
                        {(control) => (
                          <Textarea
                            {...control}
                            value={notes}
                            onChange={(event) => {
                              setNotes(event.target.value);
                              setSaved(false);
                            }}
                            placeholder="记录这个分组的监控重点…"
                          />
                        )}
                      </Field>
                      {saved && (
                        <SuccessNotice icon={<SuccessMark />}>
                          示例已保存，未写入业务数据
                        </SuccessNotice>
                      )}
                      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-5">
                        <Button type="submit">
                          <Check aria-hidden="true" />
                          保存示例
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setName('');
                            setNotes('');
                            setError(undefined);
                            setSaved(false);
                          }}
                        >
                          清空
                        </Button>
                      </div>
                    </form>
                  </CardContent>
                </Card>
              </Entrance>
              <Entrance index={4}>
                <Card>
                  <CardHeader title="空态也有下一步" />
                  <CardContent>
                    <EmptyState
                      title="还没有匹配的记录"
                      description="试试调整站点筛选，或添加第一个 ASIN，开始你的监控工作。"
                      action={
                        <Button
                          size="small"
                          variant="secondary"
                          onClick={() => setCountry('全部站点')}
                        >
                          重置示例筛选
                          <ArrowRight aria-hidden="true" />
                        </Button>
                      }
                    />
                  </CardContent>
                </Card>
              </Entrance>
              <div className="rounded-card border border-border bg-cream-raised p-5 text-xs leading-6 text-muted-foreground">
                <p className="font-semibold text-foreground">安静，但有回应</p>
                <p className="mt-1">
                  动效用于状态变化与操作反馈。系统启用“减少动态效果”时，过渡、脉冲与数字补间会自动停用。
                </p>
              </div>
            </div>
          </div>
        </main>
        <footer className="mt-10 flex flex-wrap justify-between gap-3 border-t border-border py-5 text-xs text-muted-foreground">
          <span>Neo · 组件基础预览</span>
          <span>01 / 颜色 · 02 / 交互 · 03 / 反馈</span>
        </footer>
      </div>
    </MotionProvider>
  );
}
