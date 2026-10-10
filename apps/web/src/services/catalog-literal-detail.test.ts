import { isNeoBatchDeleteId } from '@asin-monitor/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../lib/http';
import { jsonResponse, sessionFixture } from '../lib/transport-fixtures';
import { getVariantGroup } from './asin';
import { getCompetitorGroup } from './competitor-asin';

const samples = [
  'group-normal',
  ' Source Ś ',
  ' ',
  '.',
  '..',
  'a/b',
  'a?b',
  'a#b',
  'a\\b',
  '中文🔎',
  '🔎'.repeat(50),
  'a%b',
  'a+b',
  'a=b',
  'a,b',
];
const invalid = [
  '',
  'a\u0000b',
  'a\nb',
  'a\u007fb',
  'a\u0085b',
  'a\u009fb',
  '\ud800',
  '\udfff',
  '🔎'.repeat(51),
];
const clients: HttpClient[] = [];
afterEach(() => clients.splice(0).forEach((http) => http.close()));

function fixture(
  domain: 'primary' | 'competitor',
  id: string,
  baseURL = '/api/',
) {
  const group = {
    id,
    name: 'Literal detail',
    country: 'US',
    site: 'amazon.com',
    brand: 'Fixture',
    children: [
      { id: ' child /? ', asin: 'B000000242', country: 'US', parentId: id },
    ],
  };
  const reads: URL[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    reads.push(url);
    return jsonResponse({ success: true, data: group });
  });
  const http = new HttpClient({
    baseURL,
    pageOrigin: 'https://app.test',
    session: sessionFixture().store,
    fetch: fetcher,
  });
  clients.push(http);
  return {
    http,
    reads,
    fetcher,
    group,
    get: domain === 'primary' ? getVariantGroup : getCompetitorGroup,
    route:
      domain === 'primary'
        ? '/api/v1/catalog/variant-groups/detail'
        : '/api/v1/competitor/catalog/variant-groups/detail',
  };
}

describe.each(['primary', 'competitor'] as const)(
  '%s Neo literal group detail transport',
  (domain) => {
    it.each(samples)(
      'keeps the exact literal %j and complete children through the actual typed service',
      async (id) => {
        expect(isNeoBatchDeleteId(id)).toBe(true);
        const f = fixture(domain, id);
        const response = await f.get(f.http, id);
        expect(response.id).toBe(id);
        expect(response.children?.[0]).toMatchObject({
          id: ' child /? ',
          parentId: id,
        });
        expect(f.reads).toHaveLength(1);
        expect(f.reads[0].pathname).toBe(f.route);
        expect(f.reads[0].searchParams.getAll('groupId')).toEqual([id]);
        expect([...f.reads[0].searchParams.keys()]).toEqual(['groupId']);
      },
    );
    it.each(['/api', '/api/', 'https://app.test/api/'])(
      'normalizes %s without a duplicated api prefix',
      async (baseURL) => {
        const f = fixture(domain, ' Raw ', baseURL);
        await f.get(f.http, ' Raw ');
        expect(f.reads[0].origin).toBe('https://app.test');
        expect(f.reads[0].pathname).toBe(f.route);
        expect(f.reads[0].pathname).not.toContain('/api/api/');
        expect(f.reads[0].searchParams.get('groupId')).toBe(' Raw ');
      },
    );
    it.each(invalid)('rejects invalid literal %j before fetch', async (id) => {
      expect(isNeoBatchDeleteId(id)).toBe(false);
      const f = fixture(domain, id);
      await expect(f.get(f.http, id)).rejects.toMatchObject({
        kind: 'INVALID_INPUT',
      });
      expect(f.fetcher).not.toHaveBeenCalled();
    });
    it('retains generic path guards and forwards caller cancellation', async () => {
      const f = fixture(domain, '.');
      const controller = new AbortController();
      controller.abort();
      await expect(f.get(f.http, '.', controller.signal)).rejects.toMatchObject(
        { kind: 'CANCELLED' },
      );
      expect(f.fetcher).not.toHaveBeenCalled();
      for (const path of [
        '/api/v1/variant-groups/a%2Fb',
        '/api/v1/variant-groups/%252e%252e',
        '/api/v1/variant-groups/a\\b',
      ]) {
        await expect(f.http.request(path)).rejects.toMatchObject({
          kind: 'INVALID_INPUT',
        });
      }
      expect(f.fetcher).not.toHaveBeenCalled();
    });
  },
);
