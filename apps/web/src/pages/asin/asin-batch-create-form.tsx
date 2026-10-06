import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/button';
import { Field, Input, Textarea } from '../../components/ui/field';
import { Card, CardContent, CardHeader } from '../../components/ui/surfaces';
import {
  validBatchCreateText,
  type AsinBatchCreateInput,
} from '../../services/asin-batch-create';
import type { CatalogGroup } from '../catalog/catalog-types';
import { MAX_ASIN_BATCH_ITEMS, parseAsinBatchInput } from './asin-batch-input';

/** The catalog coordinator owns permissions, mutations, uncertainty and refresh. */
export function AsinBatchCreateForm({
  group,
  pending,
  error,
  submit,
  close,
}: {
  group: CatalogGroup;
  pending: boolean;
  error: string | null;
  submit: (input: AsinBatchCreateInput) => Promise<void>;
  close: () => void;
}) {
  const [input, setInput] = useState('');
  const [site, setSite] = useState(group.site ?? '');
  const [brand, setBrand] = useState(group.brand ?? '');
  const [name, setName] = useState('');
  const [asinType, setAsinType] = useState<'' | '1' | '2'>('');
  const [submitting, setSubmitting] = useState(false);
  const active = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const parsed = useMemo(() => parseAsinBatchInput(input), [input]);
  const busy = pending || submitting;
  const validSite = validBatchCreateText(site, 100, true);
  const validBrand = validBatchCreateText(brand, 100, true);
  const validName = validBatchCreateText(name, 500);
  const inputError = parsed.overflow
    ? `有效编码超过 ${MAX_ASIN_BATCH_ITEMS} 个，请拆分后提交。`
    : parsed.invalid.length
    ? `有 ${parsed.invalid.length} 个编码无效，请先修正。`
    : undefined;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      active.current ||
      busy ||
      !parsed.canSubmit ||
      !validSite ||
      !validBrand ||
      !validName
    )
      return;
    active.current = true;
    setSubmitting(true);
    try {
      await submit({
        items: parsed.codes.map((asin) => ({
          asin,
          country: group.country.trim().toUpperCase(),
          parentId: group.id,
          site,
          brand,
          name: name.trim() ? name : null,
          asinType: asinType || null,
        })),
      });
    } finally {
      active.current = false;
      if (mounted.current) setSubmitting(false);
    }
  }

  return (
    <Card aria-label="批量添加组内 ASIN">
      <CardHeader
        title="批量添加组内 ASIN"
        description="同组最多添加 1000 个 ASIN，保存后核对逐行结果。"
        action={
          <Button variant="ghost" size="small" disabled={busy} onClick={close}>
            关闭
          </Button>
        }
      />
      <CardContent>
        <form onSubmit={(event) => void onSubmit(event)} className="space-y-5">
          <p className="break-words text-sm">
            所属变体组：{group.name} · {group.country}
          </p>
          <Field
            label="ASIN 编码列表"
            required
            hint="支持换行、空格、中英文逗号或分号；自动转为大写并保留首次出现的编码。"
            error={inputError}
          >
            {(control) => (
              <Textarea
                {...control}
                value={input}
                disabled={busy}
                maxLength={50_000}
                rows={7}
                onChange={(event) => setInput(event.target.value)}
                placeholder="B000000001&#10;B000000002"
                className="neo-mono"
              />
            )}
          </Field>
          <p role="status" className="text-sm text-muted-foreground">
            有效编码 {parsed.codes.length} 个 · 已去重 {parsed.duplicateCount}{' '}
            个 · 无效编码 {parsed.invalid.length} 个
          </p>
          {parsed.invalid.length > 0 && (
            <div className="space-y-2 rounded-control bg-status-danger-soft p-4 text-sm text-status-danger">
              <p>ASIN 应为 10 位字母或数字。错误位置：</p>
              <ul className="space-y-1">
                {parsed.invalid.slice(0, 20).map((issue) => (
                  <li key={issue.position} className="break-all">
                    第 {issue.position} 项 · 第 {issue.line} 行第 {issue.column}{' '}
                    列：{issue.value.slice(0, 64)}
                  </li>
                ))}
              </ul>
              {parsed.invalid.length > 20 && (
                <p>其余 {parsed.invalid.length - 20} 项请修正后继续核对。</p>
              )}
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="站点"
              required
              error={
                site && !validSite ? '站点应为 1–100 个非控制字符。' : undefined
              }
            >
              {(control) => (
                <Input
                  {...control}
                  value={site}
                  disabled={busy}
                  maxLength={200}
                  onChange={(event) => setSite(event.target.value)}
                />
              )}
            </Field>
            <Field
              label="品牌"
              required
              error={
                brand && !validBrand
                  ? '品牌应为 1–100 个非控制字符。'
                  : undefined
              }
            >
              {(control) => (
                <Input
                  {...control}
                  value={brand}
                  disabled={busy}
                  maxLength={200}
                  onChange={(event) => setBrand(event.target.value)}
                />
              )}
            </Field>
            <Field label="ASIN 类型">
              {(control) => (
                <select
                  {...control}
                  value={asinType}
                  disabled={busy}
                  onChange={(event) =>
                    setAsinType(event.target.value as '' | '1' | '2')
                  }
                  className="w-full rounded-input border border-input bg-card px-4 py-3 text-sm"
                >
                  <option value="">未指定</option>
                  <option value="1">主链</option>
                  <option value="2">副评</option>
                </select>
              )}
            </Field>
            <Field
              label="统一名称"
              hint="可选，应用于本次所有 ASIN。"
              error={
                !validName
                  ? '名称不能超过 500 个字符或包含控制字符。'
                  : undefined
              }
            >
              {(control) => (
                <Input
                  {...control}
                  value={name}
                  disabled={busy}
                  maxLength={1000}
                  onChange={(event) => setName(event.target.value)}
                />
              )}
            </Field>
          </div>
          {error && (
            <p
              role="alert"
              className="rounded-control bg-status-danger-soft p-3 text-sm text-status-danger"
            >
              {error}
            </p>
          )}
          <Button
            type="submit"
            pending={busy}
            disabled={
              !parsed.canSubmit || !validSite || !validBrand || !validName
            }
          >
            确认添加 {parsed.codes.length} 个 ASIN
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
