import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('P3-T2 unchanged Legacy utilities', () => {
  it.each(['beijingTime', 'peakHours', 'amazon'])(
    'preserves the complete %s source apart from CRLF',
    (name) => {
      const read = (path: string) =>
        readFileSync(new URL(path, import.meta.url), 'utf8').replace(
          /\r\n/g,
          '\n',
        );
      expect(read(`./${name}.ts`)).toBe(
        read(`../../../../src/utils/${name}.ts`),
      );
    },
  );
  it('declares the same pinned dayjs version as the Legacy workspace', () => {
    const manifest = (path: string) =>
      JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
    expect(manifest('../../package.json').dependencies.dayjs).toBe(
      manifest('../../../../package.json').dependencies.dayjs,
    );
  });
});
