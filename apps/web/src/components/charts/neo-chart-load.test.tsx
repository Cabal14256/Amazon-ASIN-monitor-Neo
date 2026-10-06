// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { NeoChart } from './neo-chart';

vi.mock('./echarts-runtime', () => {
  throw new Error('chart chunk unavailable');
});
afterEach(cleanup);

it('contains a rejected lazy chunk in chart feedback without blocking the surrounding page', async () => {
  render(
    <>
      <input aria-label="页面输入" />
      <NeoChart
        label="加载失败"
        option={{ series: [{ type: 'pie', data: [{ value: 1 }] }] }}
      />
    </>,
  );
  await screen.findByText('图表暂不可用');
  const input = screen.getByRole('textbox', { name: '页面输入' });
  fireEvent.change(input, { target: { value: '仍可编辑' } });
  expect((input as HTMLInputElement).value).toBe('仍可编辑');
  expect(screen.getByRole('button', { name: '重试图表' })).toBeTruthy();
});
