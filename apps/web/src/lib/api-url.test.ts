import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as legacy from '../../../../src/utils/apiUrl';
import * as neo from './api-url';

describe('Legacy URL matrix migrated without changing the helper', () => {
  it('keeps the frozen helper source identical apart from line endings', () => {
    const read = (path: string) =>
      readFileSync(new URL(path, import.meta.url), 'utf8')
        .replace(/\r\n/g, '\n')
        .trim();
    expect(read('./api-url.ts')).toBe(read('../../../../src/utils/apiUrl.ts'));
  });
  it.each([
    undefined,
    '',
    '/',
    '/api',
    '/api/',
    '/api/v1',
    '/api/v1/',
    '/api/api',
    '/api/v1/v1',
    'https://example.test',
    'https://example.test/',
    'https://example.test/api',
    'https://example.test/api/',
    'https://example.test/api/v1',
    'https://example.test/api/v1/',
    'https://example.test/gateway/api',
    'https://api',
  ])('matches request and export/download results for base %s', (base) => {
    for (const path of [
      '/api/v1/health',
      '/v1/export/asin',
      '/api/v1/export/asin',
      'v1/export/asin',
      '/api/v1/tasks/task-1/download',
      '/api/api/v1/health',
      '/api/v1/v1/health',
      '/api/v1/',
      '/v1/export/asin?useProgress=true#download',
    ]) {
      expect(neo.resolveApiRequest(base, path)).toEqual(
        legacy.resolveApiRequest(base, path),
      );
      expect(neo.buildApiURL(base, path)).toBe(legacy.buildApiURL(base, path));
      expect(
        new URL(neo.buildApiURL(base, path), 'https://app.test').pathname,
      ).not.toContain('/api/api');
    }
  });
  it.each(['https://foreign.test/file', '//foreign.test/file'])(
    'rejects absolute endpoint %s',
    (path) => {
      expect(() => neo.buildApiURL('/api', path)).toThrow('必须使用相对地址');
    },
  );
});
