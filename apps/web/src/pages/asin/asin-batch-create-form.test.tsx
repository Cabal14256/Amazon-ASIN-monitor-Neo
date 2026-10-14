// @vitest-environment jsdom
import type { BatchCreateAsinsData } from '@asin-monitor/contracts';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferred } from '../../lib/transport-fixtures';
import type { AsinBatchCreateInput } from '../../services/asin-batch-create';
import { AsinBatchCreateForm } from './asin-batch-create-form';
import { AsinBatchCreateResult } from './asin-batch-create-result';

afterEach(cleanup);
const group = {
  id: 'Original 中文 Group ID',
  name: 'Example group',
  country: 'US',
  site: 'amazon.com',
  brand: 'Brand',
};

describe('mounted primary batch form', () => {
  it('uses API codepoint text limits without cutting valid astral characters or sending invalid fields', async () => {
    const submit = vi
      .fn<(input: AsinBatchCreateInput) => Promise<void>>()
      .mockResolvedValue(undefined);
    render(
      <AsinBatchCreateForm
        group={group}
        pending={false}
        error={null}
        submit={submit}
        close={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'ASIN 编码列表' }), {
      target: { value: 'B000000001' },
    });
    for (const [label, limit] of [
      ['站点', 100],
      ['品牌', 100],
      ['统一名称', 500],
    ] as const) {
      const input = screen.getByLabelText(new RegExp(`^${label}`));
      expect(input.getAttribute('maxlength')).toBe(String(limit * 2));
      fireEvent.change(input, { target: { value: '😀'.repeat(limit + 1) } });
      expect(
        screen
          .getByRole('button', { name: '确认添加 1 个 ASIN' })
          .hasAttribute('disabled'),
      ).toBe(true);
      fireEvent.submit(
        screen
          .getByRole('button', { name: '确认添加 1 个 ASIN' })
          .closest('form')!,
      );
      expect(submit).not.toHaveBeenCalled();
      fireEvent.change(input, { target: { value: '😀'.repeat(limit) } });
    }
    fireEvent.submit(
      screen
        .getByRole('button', { name: '确认添加 1 个 ASIN' })
        .closest('form')!,
    );
    await waitFor(() => expect(submit).toHaveBeenCalledOnce());
    expect(submit.mock.calls[0][0]).toMatchObject({
      items: [
        {
          site: '😀'.repeat(100),
          brand: '😀'.repeat(100),
          name: '😀'.repeat(500),
        },
      ],
    });
  });

  it('submits normalized first-occurrence codes, shared form fields and original group ID once', async () => {
    const response = deferred<void>();
    const submit = vi.fn(() => response.promise);
    const close = vi.fn();
    render(
      <AsinBatchCreateForm
        group={group}
        pending={false}
        error={null}
        submit={submit}
        close={close}
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'ASIN 编码列表' }), {
      target: { value: 'b000000002，B000000001\nb000000002' },
    });
    fireEvent.change(screen.getByLabelText('ASIN 类型'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByLabelText('统一名称'), {
      target: { value: ' Shared name ' },
    });
    expect(
      screen.getByText('有效编码 2 个 · 已去重 1 个 · 无效编码 0 个'),
    ).toBeTruthy();
    const form = screen
      .getByRole('button', { name: '确认添加 2 个 ASIN' })
      .closest('form')!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({
      items: ['B000000002', 'B000000001'].map((asin) => ({
        asin,
        country: 'US',
        parentId: group.id,
        site: 'amazon.com',
        brand: 'Brand',
        name: ' Shared name ',
        asinType: '2',
      })),
    });
    expect(
      screen.getByRole('button', { name: '关闭' }).hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(close).not.toHaveBeenCalled();
    response.resolve();
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '关闭' }).hasAttribute('disabled'),
      ).toBe(false),
    );
  });

  it('blocks invalid fragments and shows their original input locations', () => {
    const submit = vi.fn(async () => undefined);
    render(
      <AsinBatchCreateForm
        group={group}
        pending={false}
        error={null}
        submit={submit}
        close={() => undefined}
      />,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'ASIN 编码列表' }), {
      target: { value: 'b000000001\n  bad' },
    });
    expect(screen.getByText('第 2 项 · 第 2 行第 3 列：bad')).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: '确认添加 1 个 ASIN' })
        .hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.submit(
      screen
        .getByRole('button', { name: '确认添加 1 个 ASIN' })
        .closest('form')!,
    );
    expect(submit).not.toHaveBeenCalled();
  });

  it('disables an empty form and closes without issuing a mutation', () => {
    const submit = vi.fn(async () => undefined);
    const close = vi.fn();
    render(
      <AsinBatchCreateForm
        group={group}
        pending={false}
        error={null}
        submit={submit}
        close={close}
      />,
    );
    fireEvent.submit(
      screen
        .getByRole('button', { name: '确认添加 0 个 ASIN' })
        .closest('form')!,
    );
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(submit).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('mounted authoritative batch results', () => {
  it('shows server failure reasons and filters only failed rows without submitting anything', () => {
    const result: BatchCreateAsinsData = {
      total: 2,
      successCount: 1,
      failedCount: 1,
      results: [
        { index: 0, asin: 'B000000001', country: 'US', success: true },
        {
          index: 1,
          asin: 'B000000002',
          country: 'US',
          success: false,
          message: '该国家的 ASIN 已存在',
        },
      ],
      errors: [{ index: 1, message: '该国家的 ASIN 已存在' }],
    };
    const dismiss = vi.fn();
    render(
      <AsinBatchCreateResult
        result={result}
        groupName={group.name}
        dismiss={dismiss}
      />,
    );
    expect(screen.getByText('B000000001')).toBeTruthy();
    expect(screen.getByText('该国家的 ASIN 已存在')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '仅查看失败项' }));
    expect(screen.queryByText('B000000001')).toBeNull();
    expect(screen.getByText('第 2 项')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '查看全部结果' }));
    expect(screen.getByText('B000000001')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '关闭结果' }));
    expect(dismiss).toHaveBeenCalledOnce();
  });

  it('pages a large result while retaining submission indices', () => {
    const result: BatchCreateAsinsData = {
      total: 51,
      successCount: 51,
      failedCount: 0,
      results: Array.from({ length: 51 }, (_, index) => ({
        index,
        asin: `B${String(index).padStart(9, '0')}`,
        country: 'US',
        success: true,
      })),
      errors: [],
    };
    render(
      <AsinBatchCreateResult
        result={result}
        groupName={group.name}
        dismiss={() => undefined}
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(50);
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('第 51 项')).toBeTruthy();
  });
});
