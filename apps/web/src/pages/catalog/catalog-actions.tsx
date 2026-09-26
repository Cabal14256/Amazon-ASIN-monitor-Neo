import { useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/button';
import { Field, Input } from '../../components/ui/field';
import { Card, CardContent, CardHeader } from '../../components/ui/surfaces';
import { ApiError, type HttpClient } from '../../lib/http';
import {
  catalogAccessDenied,
  catalogActionSourceCurrent,
  catalogWriteError,
  singleAsinCode,
} from './catalog-data';
import type {
  CatalogAction,
  CatalogConfig,
  CatalogGroup,
} from './catalog-types';

function title(action: CatalogAction): string {
  switch (action.type) {
    case 'create-group':
      return '新建变体组';
    case 'edit-group':
      return '编辑变体组';
    case 'delete-group':
      return '删除变体组';
    case 'create-asin':
      return '添加组内 ASIN';
    case 'edit-asin':
      return '编辑 ASIN';
    case 'move-asin':
      return '移动 ASIN';
    case 'delete-asin':
      return '删除 ASIN';
  }
}

export function CatalogActionPanel({
  action,
  config,
  http,
  close,
  saved,
  denied,
  writingChange,
}: {
  action: CatalogAction;
  config: CatalogConfig;
  http: Pick<HttpClient, 'request'>;
  close: () => void;
  saved: (message: string, action: CatalogAction) => Promise<void>;
  denied: () => void;
  writingChange: (writing: boolean) => void;
}) {
  const writes = config.writes;
  const group = 'group' in action ? action.group : undefined;
  const child = 'child' in action ? action.child : undefined;
  const groupForm =
    action.type === 'create-group' || action.type === 'edit-group';
  const asinForm = action.type === 'create-asin' || action.type === 'edit-asin';
  const deleting =
    action.type === 'delete-group' || action.type === 'delete-asin';
  const moving = action.type === 'move-asin';
  const [name, setName] = useState(
    groupForm ? group?.name ?? '' : child?.name ?? '',
  );
  const [asin, setAsin] = useState(child?.asin ?? '');
  const [country, setCountry] = useState(
    child?.country ?? group?.country ?? '',
  );
  const [site, setSite] = useState(
    child ? child.site ?? '' : group?.site ?? '',
  );
  const [brand, setBrand] = useState(
    child ? child.brand ?? '' : group?.brand ?? '',
  );
  const [asinType, setAsinType] = useState(
    child?.asinType == null ? '' : String(child.asinType),
  );
  const [targetGroupId, setTargetGroupId] = useState('');
  const [targetSearch, setTargetSearch] = useState('');
  const [targets, setTargets] = useState<CatalogGroup[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!writes) return null;

  async function searchTargets() {
    if (searching || pending) return;
    setSearching(true);
    setError(null);
    try {
      const result = await config.list(http, {
        keyword: targetSearch.trim() || undefined,
        current: 1,
        pageSize: 20,
      });
      setTargets(result.list.filter((item) => item.id !== group?.id));
    } catch (cause) {
      if (catalogAccessDenied(cause)) denied();
      setError(catalogWriteError(cause));
    } finally {
      setSearching(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!writes || pending) return;
    setError(null);
    if (
      moving &&
      (!targetGroupId.trim() || targetGroupId.trim() === group?.id)
    ) {
      setError('请选择不同的目标变体组。');
      return;
    }
    if (action.type === 'create-asin' && !singleAsinCode(asin)) {
      setError('ASIN 应为 10 位字母或数字。');
      return;
    }
    setPending(true);
    writingChange(true);
    try {
      if ('group' in action) {
        const latest = await config.detail(http, action.group.id);
        if (!catalogActionSourceCurrent(action, latest))
          throw new ApiError('HTTP', '记录已变化', 409);
      }
      switch (action.type) {
        case 'create-group':
          await writes.createGroup(http, {
            name: name.trim(),
            country: country.trim().toUpperCase(),
            site: site.trim(),
            brand: brand.trim(),
          });
          break;
        case 'edit-group':
          await writes.updateGroup(http, action.group.id, {
            name: name.trim(),
            country: country.trim().toUpperCase(),
            site: site.trim(),
            brand: brand.trim(),
          });
          break;
        case 'delete-group':
          await writes.deleteGroup(http, action.group.id);
          break;
        case 'create-asin':
          await writes.createAsin(http, {
            asin: singleAsinCode(asin)!,
            name: name.trim() || null,
            country: country.trim().toUpperCase(),
            site: site.trim(),
            brand: brand.trim(),
            parentId: action.group.id,
            asinType: asinType ? (asinType as '1' | '2') : null,
          });
          break;
        case 'edit-asin':
          await writes.updateAsin(http, action.child.id, {
            asin: action.child.asin,
            name: name.trim() || null,
            country: country.trim().toUpperCase(),
            site: site.trim(),
            brand: brand.trim(),
            asinType: asinType ? (asinType as '1' | '2') : null,
          });
          break;
        case 'move-asin':
          await writes.moveAsin(http, action.child.id, {
            targetGroupId: targetGroupId.trim(),
          });
          break;
        case 'delete-asin':
          await writes.deleteAsin(http, action.child.id);
          break;
      }
      await saved(`${title(action)}已完成。`, action);
      close();
    } catch (cause) {
      if (catalogAccessDenied(cause)) denied();
      setError(catalogWriteError(cause));
    } finally {
      setPending(false);
      writingChange(false);
    }
  }

  return (
    <Card aria-label={title(action)}>
      <CardHeader
        title={title(action)}
        description={
          deleting
            ? action.type === 'delete-group'
              ? '删除变体组会同时删除组内所有 ASIN，请核对后确认。'
              : '请核对目标 ASIN 后确认删除。'
            : moving
            ? '请确认目标组；移动会改变当前 ASIN 的归属。'
            : '保存后重新读取目录与详情。'
        }
        action={
          <Button
            variant="ghost"
            size="small"
            disabled={pending}
            onClick={close}
          >
            关闭
          </Button>
        }
      />
      <CardContent>
        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          {deleting && (
            <p className="break-all text-sm">
              确认删除
              {action.type === 'delete-group'
                ? `变体组「${group?.name}」`
                : `ASIN「${child?.asin}」`}
              ？
            </p>
          )}
          {groupForm && (
            <Field label="变体组名称" required>
              {(control) => (
                <Input
                  {...control}
                  value={name}
                  maxLength={255}
                  onChange={(event) => setName(event.target.value)}
                />
              )}
            </Field>
          )}
          {asinForm && (
            <>
              <Field label="ASIN" required>
                {(control) => (
                  <Input
                    {...control}
                    value={asin}
                    maxLength={10}
                    disabled={action.type === 'edit-asin'}
                    onChange={(event) => setAsin(event.target.value)}
                  />
                )}
              </Field>
              <Field label="名称">
                {(control) => (
                  <Input
                    {...control}
                    value={name}
                    maxLength={500}
                    onChange={(event) => setName(event.target.value)}
                  />
                )}
              </Field>
            </>
          )}
          {(groupForm || asinForm) && (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="国家代码" required>
                {(control) => (
                  <Input
                    {...control}
                    value={country}
                    maxLength={10}
                    onChange={(event) => setCountry(event.target.value)}
                  />
                )}
              </Field>
              <Field label="站点" hint="填写店铺代号，例如 12。" required>
                {(control) => (
                  <Input
                    {...control}
                    value={site}
                    maxLength={100}
                    onChange={(event) => setSite(event.target.value)}
                  />
                )}
              </Field>
              <Field label="品牌" required>
                {(control) => (
                  <Input
                    {...control}
                    value={brand}
                    maxLength={100}
                    onChange={(event) => setBrand(event.target.value)}
                  />
                )}
              </Field>
            </div>
          )}
          {asinForm && (
            <Field label="ASIN 类型">
              {(control) => (
                <select
                  {...control}
                  value={asinType}
                  onChange={(event) => setAsinType(event.target.value)}
                  className="w-full rounded-input border border-input bg-card px-4 py-3 text-sm"
                >
                  <option value="">未指定</option>
                  <option value="1">主链</option>
                  <option value="2">副评</option>
                </select>
              )}
            </Field>
          )}
          {moving && (
            <>
              <Field
                label="查找目标变体组"
                hint="输入名称、编号或 ASIN；最多显示前 20 个结果。"
              >
                {(control) => (
                  <Input
                    {...control}
                    value={targetSearch}
                    maxLength={200}
                    onChange={(event) => setTargetSearch(event.target.value)}
                  />
                )}
              </Field>
              <Button
                variant="secondary"
                pending={searching}
                onClick={() => void searchTargets()}
              >
                查找目标组
              </Button>
              {targets && (
                <div className="max-h-44 space-y-1 overflow-y-auto rounded-control border border-border p-2">
                  {targets.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                      未找到其他变体组。
                    </p>
                  )}
                  {targets.map((target) => (
                    <Button
                      key={target.id}
                      variant={
                        targetGroupId === target.id ? 'primary' : 'ghost'
                      }
                      size="small"
                      className="w-full justify-start"
                      onClick={() => setTargetGroupId(target.id)}
                    >
                      {target.name} · {target.country} · {target.site} ·{' '}
                      {target.id}
                    </Button>
                  ))}
                </div>
              )}
              {targetGroupId && (
                <p className="break-all text-sm">目标组 ID：{targetGroupId}</p>
              )}
            </>
          )}
          {error && (
            <p role="alert" className="text-sm text-status-danger">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button
              type="submit"
              variant={deleting ? 'destructive' : 'primary'}
              pending={pending}
              disabled={moving && !targetGroupId}
            >
              {deleting ? '确认删除' : moving ? '确认移动' : '保存'}
            </Button>
            <Button variant="secondary" disabled={pending} onClick={close}>
              取消
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
