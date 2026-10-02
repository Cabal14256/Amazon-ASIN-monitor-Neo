// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../../lib/http';
import { jsonResponse, sessionFixture } from '../../lib/transport-fixtures';
import { COMPETITOR_CATALOG } from '../competitor-asin/config';
import { CatalogActionPanel } from './catalog-actions';
import type { CatalogAction } from './catalog-types';

const child = {
  id: ' Child α ',
  asin: 'B00RIVAL00',
  name: ' Rival child ',
  country: 'DE',
  brand: ' Child brand ',
  asinType: '2',
};
const group = {
  id: ' Gróup source ',
  name: ' Rival group ',
  country: 'DE',
  brand: ' Group brand ',
  children: [child],
};
const actions = [
  { type: 'create-group' },
  { type: 'edit-group', group },
  { type: 'create-asin', group },
  { type: 'edit-asin', group, child },
] as const;
const clients: HttpClient[] = [];
afterEach(() => {
  cleanup();
  for (const http of clients.splice(0)) http.close();
});

function mounted(action: CatalogAction, baseURL: string) {
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    if (options?.method === 'GET')
      return jsonResponse({ success: true, data: group });
    const body = JSON.parse(String(options?.body));
    return jsonResponse({
      success: true,
      data: new URL(String(url)).pathname.includes('/asins')
        ? { ...child, ...body, variantGroupId: group.id }
        : { ...group, ...body },
    });
  });
  const http = new HttpClient({
    baseURL,
    pageOrigin: 'https://app.test',
    session: sessionFixture().store,
    fetch: fetcher,
  });
  clients.push(http);
  const saved = vi.fn(async () => undefined);
  const beginWrite = vi.fn(() => ({
    phase: 'refresh' as const,
    message: null,
    detailId: null,
    createUncertain: false,
  }));
  render(
    <CatalogActionPanel
      action={action}
      config={COMPETITOR_CATALOG}
      http={http}
      saved={saved}
      close={vi.fn()}
      denied={vi.fn()}
      uncertain={vi.fn()}
      writingChange={vi.fn()}
      runExclusive={async (work) => work()}
      beginWrite={beginWrite}
      releaseWrite={vi.fn()}
    />,
  );
  if (action.type === 'create-group') {
    change('变体组名称', group.name);
    change('国家代码', group.country);
    change('品牌', group.brand);
  }
  if (action.type === 'create-asin') change('ASIN', child.asin);
  return { fetcher, saved, beginWrite };
}
function input(label: string) {
  return screen.getByLabelText(
    new RegExp(`^${label}[ ]*[*]?$`),
  ) as HTMLInputElement;
}
function change(label: string, value: string) {
  fireEvent.change(input(label), { target: { value } });
}
function submit() {
  fireEvent.click(screen.getByRole('button', { name: '保存' }));
}
function write(f: ReturnType<typeof mounted>) {
  return f.fetcher.mock.calls.filter((call) => call[1]?.method !== 'GET');
}

describe('competitor form text boundaries through the actual HttpClient', () => {
  describe.each(['/api/', 'https://app.test/gateway/api/'])('%s', (baseURL) => {
    it.each(actions)(
      'allows full Unicode code-point limits for $type without truncation',
      async (action) => {
        const f = mounted(action, baseURL);
        const isGroup = action.type.endsWith('group');
        const name = '🔎'.repeat(isGroup ? 255 : 500);
        const brand = '🌟'.repeat(100);
        const nameLabel = isGroup ? '变体组名称' : '名称';
        // HTML maxLength counts UTF-16 units: the browser must let a valid
        // PostgreSQL/API character-length value reach the code-point validator.
        expect(input(nameLabel).maxLength).toBeGreaterThanOrEqual(name.length);
        expect(input('品牌').maxLength).toBeGreaterThanOrEqual(brand.length);
        change(nameLabel, name);
        change('品牌', brand);
        submit();
        await waitFor(() => expect(f.saved).toHaveBeenCalledOnce());
        const calls = write(f);
        expect(calls).toHaveLength(1);
        expect(JSON.parse(String(calls[0][1]?.body))).toMatchObject({
          name,
          brand,
        });
        expect(
          f.fetcher.mock.calls.every(
            ([url]) => !String(url).includes('/api/api/'),
          ),
        ).toBe(true);
        expect(String(calls[0][0])).toContain(
          baseURL.startsWith('https:')
            ? '/gateway/api/v1/competitor/'
            : '/api/v1/competitor/',
        );
      },
    );
    it.each(actions.filter((action) => action.type.startsWith('edit')))(
      'preserves unchanged persisted name and brand spaces in $type',
      async (action) => {
        const f = mounted(action, baseURL);
        submit();
        await waitFor(() => expect(f.saved).toHaveBeenCalledOnce());
        const expected = action.type === 'edit-group' ? group : child;
        const body = JSON.parse(String(write(f)[0][1]?.body));
        expect(body).toMatchObject({
          name: expected.name,
          brand: expected.brand,
        });
        expect(body.expectedSource).toMatchObject({
          name: expected.name,
          brand: expected.brand,
        });
      },
    );
  });

  it.each(actions.filter((action) => action.type.startsWith('create')))(
    'preserves entered text and optional whitespace in $type',
    async (action) => {
      const f = mounted(action, '/api/');
      const name = action.type === 'create-group' ? ' Entered group ' : '   ';
      const brand = ' Entered brand ';
      change(action.type === 'create-group' ? '变体组名称' : '名称', name);
      change('品牌', brand);
      submit();
      await waitFor(() => expect(f.saved).toHaveBeenCalledOnce());
      expect(JSON.parse(String(write(f)[0][1]?.body))).toMatchObject({
        name,
        brand,
      });
    },
  );

  it('allows the API country code-point limit and retains its existing normalization', async () => {
    const f = mounted(actions[0], '/api/');
    const country = '🌐'.repeat(10);
    expect(input('国家代码').maxLength).toBeGreaterThanOrEqual(country.length);
    change('国家代码', country);
    submit();
    await waitFor(() => expect(f.saved).toHaveBeenCalledOnce());
    expect(JSON.parse(String(write(f)[0][1]?.body))).toMatchObject({ country });
  });

  it.each([
    { action: actions[0], label: '变体组名称', value: 'A'.repeat(256) },
    { action: actions[3], label: '名称', value: 'A'.repeat(501) },
    { action: actions[1], label: '品牌', value: 'A'.repeat(101) },
    { action: actions[2], label: '品牌', value: 'A'.repeat(101) },
    { action: actions[1], label: '变体组名称', value: '   ' },
    { action: actions[3], label: '品牌', value: '   ' },
    { action: actions[0], label: '国家代码', value: 'A'.repeat(11) },
    { action: actions[1], label: '品牌', value: 'Rival\tunsafe' },
    { action: actions[3], label: '名称', value: 'Child\tunsafe' },
  ])(
    'rejects invalid $action.type / $label before preflight or claiming a write',
    async ({ action, label, value }) => {
      const f = mounted(action, '/api/');
      change(label, value);
      submit();
      await screen.findByRole('alert');
      expect(f.fetcher).not.toHaveBeenCalled();
      expect(f.beginWrite).not.toHaveBeenCalled();
      expect(f.saved).not.toHaveBeenCalled();
    },
  );
});
