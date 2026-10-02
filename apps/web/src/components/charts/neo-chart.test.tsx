// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prepareChartOption, type NeoChartOption } from './chart-option';
import { NeoChart } from './neo-chart';

const deferred = vi.hoisted(() => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release, init: vi.fn() };
});
vi.mock('./echarts-runtime', async () => {
  await deferred.ready;
  return { init: deferred.init };
});

const option: NeoChartOption = {
  xAxis: { type: 'category', data: ['A', 'B'] },
  yAxis: { type: 'value' },
  series: [{ type: 'line', data: [2, 4] }],
};
let width = 600;
let height = 300;
let reduced = false;
const motionListeners = new Set<() => void>();
const observers: Array<{
  callback: () => void;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}> = [];
const instances: Array<{
  setOption: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
}> = [];

beforeEach(() => {
  width = 600;
  height = 300;
  reduced = false;
  observers.length = 0;
  instances.length = 0;
  motionListeners.clear();
  deferred.init.mockReset().mockImplementation(() => {
    const chart = { setOption: vi.fn(), resize: vi.fn(), dispose: vi.fn() };
    instances.push(chart);
    return chart;
  });
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(
    () => width,
  );
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(
    () => height,
  );
  vi.stubGlobal(
    'ResizeObserver',
    class {
      callback: () => void;
      observe = vi.fn();
      disconnect = vi.fn();
      constructor(callback: () => void) {
        this.callback = callback;
        observers.push(this);
      }
    },
  );
  vi.stubGlobal('matchMedia', () => ({
    matches: reduced,
    addEventListener: (_: string, callback: () => void) =>
      motionListeners.add(callback),
    removeEventListener: (_: string, callback: () => void) =>
      motionListeners.delete(callback),
  }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('mounted NeoChart lifecycle', () => {
  it('never initializes a late module after the loading chart has unmounted', async () => {
    const view = render(<NeoChart label="迟到加载" option={option} />);
    expect(screen.getByRole('status').textContent).toContain('正在加载图表');
    view.unmount();
    deferred.release();
    await vi.dynamicImportSettled();
    expect(deferred.init).not.toHaveBeenCalled();
    expect(observers[0].disconnect).toHaveBeenCalledOnce();
  });

  it('initializes SVG, updates the existing instance without merging stale series and disposes once', async () => {
    const view = render(<NeoChart label="实时绘制" option={option} />);
    await waitFor(() => expect(deferred.init).toHaveBeenCalledOnce());
    expect(deferred.init.mock.calls[0][2]).toEqual({
      renderer: 'svg',
      width: 600,
      height: 300,
    });
    expect(screen.queryByRole('status')).toBeNull();
    const next: NeoChartOption = {
      series: [{ type: 'pie', data: [{ name: 'C', value: 5 }] }],
    };
    view.rerender(<NeoChart label="实时绘制" option={next} />);
    expect(deferred.init).toHaveBeenCalledOnce();
    expect(instances[0].setOption.mock.lastCall?.[0].series).toHaveLength(1);
    expect(instances[0].setOption.mock.lastCall?.[0].series[0].type).toBe(
      'pie',
    );
    expect(instances[0].setOption.mock.lastCall?.[1]).toEqual({
      notMerge: true,
    });
    view.unmount();
    expect(instances[0].dispose).toHaveBeenCalledOnce();
    expect(observers[0].disconnect).toHaveBeenCalledOnce();
    expect(motionListeners.size).toBe(0);
  });

  it('waits for a hidden container then resizes on element and window changes', async () => {
    width = 0;
    render(<NeoChart label="可见后绘制" option={option} />);
    await vi.dynamicImportSettled();
    expect(deferred.init).not.toHaveBeenCalled();
    width = 390;
    act(() => observers[0].callback());
    expect(deferred.init).toHaveBeenCalledOnce();
    width = 320;
    act(() => observers[0].callback());
    expect(instances[0].resize).toHaveBeenLastCalledWith({
      width: 320,
      height: 300,
    });
    height = 260;
    fireEvent(window, new Event('resize'));
    expect(instances[0].resize).toHaveBeenLastCalledWith({
      width: 320,
      height: 260,
    });
  });

  it('uses window resize when ResizeObserver is unavailable', async () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const view = render(<NeoChart label="兼容尺寸变化" option={option} />);
    await waitFor(() => expect(deferred.init).toHaveBeenCalledOnce());
    width = 280;
    fireEvent(window, new Event('resize'));
    expect(instances[0].resize).toHaveBeenCalledWith({
      width: 280,
      height: 300,
    });
    view.unmount();
    fireEvent(window, new Event('resize'));
    expect(instances[0].resize).toHaveBeenCalledOnce();
  });

  it('does not load an instance for caller loading, empty or error; releases it when data becomes empty', async () => {
    const view = render(<NeoChart label="数据状态" option={option} loading />);
    expect(screen.getByRole('status')).toBeTruthy();
    view.rerender(<NeoChart label="数据状态" option={option} empty />);
    expect(screen.getByText('暂无图表数据')).toBeTruthy();
    view.rerender(
      <NeoChart
        label="数据状态"
        option={option}
        error="查询失败，可继续使用页面"
      />,
    );
    expect(screen.getByText('查询失败，可继续使用页面')).toBeTruthy();
    await vi.dynamicImportSettled();
    expect(deferred.init).not.toHaveBeenCalled();
    view.rerender(<NeoChart label="数据状态" option={option} />);
    await waitFor(() => expect(deferred.init).toHaveBeenCalledOnce());
    view.rerender(<NeoChart label="数据状态" option={option} empty />);
    expect(instances[0].dispose).toHaveBeenCalledOnce();
  });

  it('shows a recoverable drawing failure and retries with a new instance', async () => {
    deferred.init.mockImplementationOnce(() => {
      const chart = {
        setOption: vi.fn(() => {
          throw new Error('invalid drawing');
        }),
        resize: vi.fn(),
        dispose: vi.fn(),
      };
      instances.push(chart);
      return chart;
    });
    render(<NeoChart label="绘制失败恢复" option={option} />);
    await screen.findByText('图表暂不可用');
    expect(instances[0].dispose).toHaveBeenCalledOnce();
    act(() => observers[0].callback());
    expect(deferred.init).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: '重试图表' }));
    await waitFor(() => expect(deferred.init).toHaveBeenCalledTimes(2));
    expect(screen.queryByText('图表暂不可用')).toBeNull();
  });

  it('handles initialization failure and permits explicit retry', async () => {
    deferred.init.mockImplementationOnce(() => {
      throw new Error('renderer failed');
    });
    render(<NeoChart label="初始化失败" option={option} />);
    await screen.findByText('图表暂不可用');
    fireEvent.click(screen.getByRole('button', { name: '重试图表' }));
    await waitFor(() => expect(deferred.init).toHaveBeenCalledTimes(2));
    expect(instances[0].setOption).toHaveBeenCalledOnce();
  });

  it('retains exactly one live instance during StrictMode async effect replay', async () => {
    const view = render(
      <StrictMode>
        <NeoChart label="严格生命周期" option={option} />
      </StrictMode>,
    );
    await act(async () => {
      await vi.dynamicImportSettled();
    });
    await waitFor(() => expect(deferred.init).toHaveBeenCalledOnce());
    expect(observers).toHaveLength(2);
    expect(observers[0].disconnect).toHaveBeenCalledOnce();
    view.unmount();
    expect(instances[0].dispose).toHaveBeenCalledOnce();
  });

  it('responds to reduced motion at mount and while an existing chart is displayed', async () => {
    reduced = true;
    render(
      <NeoChart
        label="减少动效"
        option={{
          ...option,
          animationDurationUpdate: 5000,
          series: [
            {
              type: 'line',
              data: [1],
              animation: true,
              animationDurationUpdate: 2000,
            },
          ],
        }}
      />,
    );
    await waitFor(() => expect(deferred.init).toHaveBeenCalledOnce());
    let prepared = instances[0].setOption.mock.lastCall?.[0];
    expect(prepared).toMatchObject({
      animation: false,
      animationDuration: 0,
      animationDurationUpdate: 0,
    });
    expect(prepared.series[0]).toMatchObject({
      animation: false,
      animationDurationUpdate: 0,
    });
    reduced = false;
    act(() => motionListeners.forEach((listener) => listener()));
    prepared = instances[0].setOption.mock.lastCall?.[0];
    expect(prepared.animationDurationUpdate).toBe(400);
    expect(prepared.series[0].animationDurationUpdate).toBe(400);
    expect(deferred.init).toHaveBeenCalledOnce();
  });
});

describe('chart option policy', () => {
  it('inherits global motion while preserving explicit series overrides within the cap', () => {
    const host = document.createElement('div');
    const source: NeoChartOption = {
      animation: false,
      animationDuration: 60,
      animationDurationUpdate: 90,
      series: [
        { type: 'bar', data: [3] },
        {
          type: 'line',
          data: [2],
          animation: true,
          animationDurationUpdate: 800,
        },
      ],
    };
    const prepared = prepareChartOption(source, host, false);
    expect(prepared).toMatchObject({
      animation: false,
      animationDuration: 60,
      animationDurationUpdate: 90,
    });
    expect(prepared.series).toEqual([
      expect.objectContaining({
        animation: false,
        animationDuration: 60,
        animationDurationUpdate: 90,
      }),
      expect.objectContaining({
        animation: true,
        animationDuration: 60,
        animationDurationUpdate: 400,
      }),
    ]);
    expect(prepareChartOption(source, host, true).series).toEqual([
      expect.objectContaining({
        animation: false,
        animationDuration: 0,
        animationDurationUpdate: 0,
      }),
      expect.objectContaining({
        animation: false,
        animationDuration: 0,
        animationDurationUpdate: 0,
      }),
    ]);
  });
  it('reads Neo colors from the host and preserves explicit series colors without mutating input', () => {
    const host = document.createElement('div');
    host.style.setProperty('--color-module-monitor', '#123456');
    const source: NeoChartOption = {
      series: {
        type: 'bar',
        data: [3],
        itemStyle: { color: '#abcdef' },
        animationDurationUpdate: 900,
      },
    };
    const prepared = prepareChartOption(source, host, false);
    expect(prepared.color).toEqual(expect.arrayContaining(['#123456']));
    expect(prepared.series).toEqual([
      expect.objectContaining({
        itemStyle: { color: '#abcdef' },
        animationDurationUpdate: 400,
      }),
    ]);
    expect(source.series).toEqual({
      type: 'bar',
      data: [3],
      itemStyle: { color: '#abcdef' },
      animationDurationUpdate: 900,
    });
  });

  it('caps unsafe durations including callbacks and clamps negatives; reduced motion removes delays', () => {
    const host = document.createElement('div');
    const source: NeoChartOption = {
      animationDurationUpdate: () => 10000,
      series: [
        {
          type: 'pie',
          animationDuration: -10,
          animationDelayUpdate: 3000,
          data: [],
        },
      ],
    };
    const prepared = prepareChartOption(source, host, false);
    expect(prepared.animationDurationUpdate).toBe(300);
    expect(prepared.series).toEqual([
      expect.objectContaining({
        animationDuration: 0,
        animationDelayUpdate: 0,
      }),
    ]);
    expect(prepareChartOption(source, host, true)).toMatchObject({
      animation: false,
      animationDuration: 0,
      animationDelayUpdate: 0,
    });
  });
});
