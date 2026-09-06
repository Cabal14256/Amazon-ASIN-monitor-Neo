import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Button } from './button';
import { FilterChip, Progress, StatusBadge, SuccessNotice } from './feedback';
import { Field, Input, Textarea } from './field';

describe('native action semantics', () => {
  it('does not submit its surrounding form unless explicitly requested', () => {
    expect(renderToStaticMarkup(<Button>取消</Button>)).toContain(
      'type="button"',
    );
    expect(renderToStaticMarkup(<Button type="submit">保存</Button>)).toContain(
      'type="submit"',
    );
  });

  it('makes an in-flight action disabled even when disabled is explicitly false', () => {
    const html = renderToStaticMarkup(
      <Button pending disabled={false}>
        保存中
      </Button>,
    );
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('保存中');
  });

  it('keeps a policy-disabled action disabled without announcing loading', () => {
    const html = renderToStaticMarkup(<Button disabled>导出</Button>);
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('aria-busy');
  });

  it.each([true, false])(
    'announces the filter selection %s and cannot submit',
    (selected) => {
      const html = renderToStaticMarkup(
        <FilterChip selected={selected}>美国</FilterChip>,
      );
      expect(html).toContain(`aria-pressed="${selected}"`);
      expect(html).toContain('type="button"');
    },
  );
});

describe('field accessibility relationships', () => {
  it('connects the label, hint and error to one required control with unique ids', () => {
    const html = renderToStaticMarkup(
      <>
        <Field label="名称" hint="便于查找" error="名称不能为空" required>
          {(control) => <Input {...control} />}
        </Field>
        <Field label="备注">{(control) => <Textarea {...control} />}</Field>
      </>,
    );
    const inputId = /<input[^>]*\sid="([^"]+)"/.exec(html)?.[1];
    const textareaId = /<textarea[^>]*\sid="([^"]+)"/.exec(html)?.[1];
    expect(inputId).toBeTruthy();
    expect(textareaId).toBeTruthy();
    expect(inputId).not.toBe(textareaId);
    expect(html).toContain(`for="${inputId}"`);
    expect(html).toContain(`for="${textareaId}"`);
    expect(html).toContain(
      `aria-describedby="${inputId}-hint ${inputId}-error"`,
    );
    expect(html).toContain(`id="${inputId}-hint"`);
    expect(html).toContain(`id="${inputId}-error"`);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-required="true"');
    expect(html).toContain(' required=""');
    expect(html).toContain('role="alert"');
  });

  it('does not reference nonexistent descriptions or mark an optional field required', () => {
    const html = renderToStaticMarkup(
      <Field label="备注">{(control) => <Textarea {...control} />}</Field>,
    );
    expect(html).not.toContain('aria-describedby');
    expect(html).not.toContain('required=');
    expect(html).toContain('aria-invalid="false"');
  });
});

describe('honest progress and status feedback', () => {
  it.each([undefined, null, NaN, Infinity, -Infinity])(
    'does not report completion for unknown progress %s',
    (value) => {
      const html = renderToStaticMarkup(
        <Progress value={value} label="导出任务" />,
      );
      expect(html).toContain('role="progressbar"');
      expect(html).toContain('aria-label="导出任务"');
      expect(html).not.toContain('aria-valuenow');
      expect(html).toContain('等待进度');
    },
  );

  it.each([
    [-2, 0],
    [0, 0],
    [36.5, 36.5],
    [100, 100],
    [105, 100],
  ])('bounds determinate progress %s to %s', (value, expected) => {
    const html = renderToStaticMarkup(
      <Progress value={value} label="导出任务" />,
    );
    expect(html).toContain(`aria-valuenow="${expected}"`);
    expect(html).toContain('aria-valuemin="0"');
    expect(html).toContain('aria-valuemax="100"');
  });

  it.each([
    ['success', '正常'],
    ['danger', '异常'],
    ['warning', '预警'],
    ['running', '进行中'],
    ['pending', '等待中'],
    ['unknown', '未知'],
  ] as const)(
    'expresses %s in text without relying on color or an unnamed icon',
    (status, label) => {
      const html = renderToStaticMarkup(<StatusBadge status={status} />);
      expect(html).toContain(label);
      expect(html).toContain('aria-hidden="true"');
    },
  );

  it('announces success without taking focus away from the user', () => {
    const html = renderToStaticMarkup(
      <SuccessNotice>设置已保存</SuccessNotice>,
    );
    expect(html).toContain('role="status"');
    expect(html).toContain('设置已保存');
    expect(html).not.toContain('tabindex');
  });
});
