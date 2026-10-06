import { useState } from 'react';
import type { NeoChartOption } from '../../components/charts/chart-option';
import { NeoChart } from '../../components/charts/neo-chart';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader } from '../../components/ui/surfaces';

/** Fictional specimens only: this entire route is excluded in production. */
export function ChartPreview() {
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState('ready');
  const [visible, setVisible] = useState(true);
  const common: NeoChartOption = {
    grid: { left: 40, right: 20, top: 24, bottom: 36 },
    tooltip: { trigger: 'axis', renderMode: 'richText' },
    xAxis: {
      type: 'category',
      data: ['一', '二', '三', '四', '五', '六', '日'],
    },
    yAxis: { type: 'value' },
  };
  const line: NeoChartOption = {
    ...common,
    series: [
      {
        type: 'line',
        name: '示例 A',
        data: [12, 18, 15, 26, 22, 30, 24 + revision],
        smooth: true,
      },
      {
        type: 'line',
        name: '示例 B',
        data: [8, 10, 13, 12, 18, 20, 19 + revision],
      },
    ],
  };
  const bar: NeoChartOption = {
    ...common,
    series: [
      {
        type: 'bar',
        name: '示例',
        data: [9, 14, 11, 18, 16, 21, 20 + revision],
      },
    ],
  };
  const pie: NeoChartOption = {
    tooltip: { trigger: 'item', renderMode: 'richText' },
    legend: { bottom: 0 },
    series: [
      {
        type: 'pie',
        radius: ['35%', '65%'],
        label: { show: false },
        data: [
          { name: '示例 A', value: 48 + revision },
          { name: '示例 B', value: 32 },
          { name: '示例 C', value: 20 },
        ],
      },
    ],
  };
  return (
    <section className="mt-8 space-y-4" aria-label="图表开发预览">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">图表 · 虚构示例</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            ECharts 6 / SVG · 使用 Neo Token；示例不代表监控结果。
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="small"
            variant="secondary"
            onClick={() => setRevision((value) => value + 1)}
          >
            更新示例数值
          </Button>
          <Button
            size="small"
            variant="ghost"
            onClick={() => setVisible((value) => !value)}
          >
            {visible ? '卸载图表' : '重新挂载图表'}
          </Button>
          <select
            aria-label="图表示例状态"
            className="rounded-control border border-border bg-surface px-3 text-sm"
            value={state}
            onChange={(event) => setState(event.target.value)}
          >
            <option value="ready">有数据</option>
            <option value="loading">加载中</option>
            <option value="empty">无数据</option>
            <option value="error">查询失败</option>
          </select>
        </div>
      </div>
      {visible && (
        <div className="grid min-w-0 gap-5 lg:grid-cols-3">
          {[
            { title: '折线图', option: line },
            { title: '柱状图', option: bar },
            { title: '饼图', option: pie },
          ].map(({ title, option }) => (
            <Card key={title}>
              <CardHeader title={title} />
              <CardContent>
                <NeoChart
                  label={`${title}：虚构开发示例`}
                  option={option}
                  loading={state === 'loading'}
                  empty={state === 'empty'}
                  error={
                    state === 'error'
                      ? '示例查询失败，页面仍可操作。'
                      : undefined
                  }
                  height={260}
                />
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
