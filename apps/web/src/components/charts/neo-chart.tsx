import type { EChartsType } from 'echarts/core';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '../ui/button';
import { EmptyState } from '../ui/feedback';
import { prepareChartOption, type NeoChartOption } from './chart-option';

const reducedMotionQuery = '(prefers-reduced-motion: reduce)';
let runtimePromise: Promise<typeof import('./echarts-runtime')> | undefined;
function loadRuntime() {
  return (runtimePromise ??= import('./echarts-runtime').catch(
    (error: unknown) => {
      runtimePromise = undefined;
      throw error;
    },
  ));
}
function subscribeMotion(listener: () => void) {
  const query = window.matchMedia?.(reducedMotionQuery);
  query?.addEventListener('change', listener);
  return () => query?.removeEventListener('change', listener);
}
function motionSnapshot() {
  return window.matchMedia?.(reducedMotionQuery).matches ?? false;
}

export interface NeoChartProps {
  option: NeoChartOption;
  label: string;
  /** Caller decides emptiness from its actual data, before loading ECharts. */
  empty?: boolean;
  loading?: boolean;
  error?: string;
  height?: number;
}

export function NeoChart({
  option,
  label,
  empty = false,
  loading = false,
  error,
  height = 300,
}: NeoChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const latest = useRef({ option, reduced: false });
  const applyRef = useRef<(() => void) | undefined>(undefined);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>(
    'loading',
  );
  const [attempt, setAttempt] = useState(0);
  const reduced = useSyncExternalStore(
    subscribeMotion,
    motionSnapshot,
    () => false,
  );
  const drawable = !loading && !error && !empty;

  useEffect(() => {
    latest.current = { option, reduced };
    applyRef.current?.();
  }, [option, reduced]);

  useEffect(() => {
    const host = hostRef.current;
    if (!drawable || !host) return;
    let active = true;
    let failed = false;
    let chart: EChartsType | undefined;
    let runtime: typeof import('./echarts-runtime') | undefined;
    setStatus('loading');
    const fail = () => {
      failed = true;
      chart?.dispose();
      chart = undefined;
      if (active) setStatus('error');
    };
    const apply = () => {
      if (!active || failed || !chart) return;
      try {
        chart.setOption(
          prepareChartOption(
            latest.current.option,
            host,
            latest.current.reduced,
          ),
          { notMerge: true },
        );
      } catch {
        fail();
      }
    };
    applyRef.current = apply;
    const resize = () => {
      if (!active || failed || !runtime || !host.isConnected) return;
      const width = host.clientWidth;
      const measuredHeight = host.clientHeight;
      if (width <= 0 || measuredHeight <= 0) return;
      try {
        if (!chart) {
          chart = runtime.init(host, undefined, {
            renderer: 'svg',
            width,
            height: measuredHeight,
          });
          apply();
          if (!failed) setStatus('ready');
        } else {
          chart.resize({ width, height: measuredHeight });
        }
      } catch {
        fail();
      }
    };
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(resize);
    observer?.observe(host);
    window.addEventListener('resize', resize);
    void loadRuntime()
      .then((module) => {
        if (!active) return;
        runtime = module;
        resize();
      })
      .catch(() => {
        if (active) fail();
      });
    return () => {
      active = false;
      observer?.disconnect();
      window.removeEventListener('resize', resize);
      if (applyRef.current === apply) applyRef.current = undefined;
      chart?.dispose();
      chart = undefined;
    };
  }, [drawable, attempt]);

  const feedback = loading
    ? 'loading'
    : error
    ? 'error'
    : empty
    ? 'empty'
    : status;
  return (
    <figure className="relative min-w-0" aria-label={label}>
      {drawable && (
        <div
          ref={hostRef}
          data-chart-host
          className="w-full min-w-0"
          style={{ height }}
        />
      )}
      {feedback !== 'ready' && (
        <div
          className={
            drawable
              ? 'absolute inset-0 flex items-center justify-center bg-surface'
              : 'flex items-center justify-center'
          }
          style={{ minHeight: height }}
        >
          {feedback === 'loading' ? (
            <p role="status" className="text-sm text-muted-foreground">
              正在加载图表…
            </p>
          ) : feedback === 'empty' ? (
            <EmptyState
              title="暂无图表数据"
              description="有可用数据后，图表会在这里显示。"
            />
          ) : (
            <EmptyState
              title="图表暂不可用"
              description={error || '加载或绘制失败，可以重试。'}
              action={
                !error && (
                  <Button
                    size="small"
                    variant="secondary"
                    onClick={() => setAttempt((value) => value + 1)}
                  >
                    重试图表
                  </Button>
                )
              }
            />
          )}
        </div>
      )}
    </figure>
  );
}
