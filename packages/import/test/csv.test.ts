import iconv from 'iconv-lite';
import { mkdtemp, open, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IMPORT_MAX_FILE_BYTES, parseCsvFile } from '../src/csv';
import type { ImportPlan } from '../src/rows';

const legacyPath = resolve(
  __dirname,
  '../../../server/src/services/importParserService.js',
);
const legacy = createRequire(legacyPath)(legacyPath) as {
  parseImportFile(file: {
    originalname: string;
    buffer: Buffer;
  }): Promise<ImportPlan>;
};
const header = '变体组名称,国家,站点,品牌,ASIN,ASIN类型';
const record = '主营组,US,店铺,品牌,b000000001,1';
const dirs: string[] = [];
async function file(bytes: Buffer | string) {
  const dir = await mkdtemp(join(tmpdir(), 'neo-import-csv-'));
  dirs.push(dir);
  const path = join(dir, 'fixture.csv');
  await writeFile(path, bytes);
  return path;
}
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

async function compare(buffer: Buffer) {
  const path = await file(buffer);
  const expected = await legacy.parseImportFile({
    originalname: 'fixture.csv',
    buffer,
  });
  const actual = await parseCsvFile(path);
  expect(actual).toEqual(expected);
  return actual;
}

describe('real CSV bytes compared with the actual Legacy ExcelJS parser', () => {
  it.each(['utf8', 'utf8-bom', 'utf16-le', 'utf16-be', 'gb18030'])(
    'decodes %s without changing grouped records or row errors',
    async (encoding) => {
      const text = `${header}\r\n${record}\r\n${record}\r\n其他组,UK,店铺,品牌,b000000002,2`;
      const bytes =
        encoding === 'utf8-bom'
          ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])
          : encoding.startsWith('utf16')
          ? Buffer.concat([
              Buffer.from(
                encoding === 'utf16-le' ? [0xff, 0xfe] : [0xfe, 0xff],
              ),
              iconv.encode(text, encoding),
            ])
          : iconv.encode(text, encoding);
      const actual = await compare(bytes);
      expect(actual.groupedItems).toHaveLength(2);
      expect(actual.errors).toEqual([
        { row: 3, message: 'ASIN B000000001 在当前文件同一变体组中重复，跳过' },
      ]);
    },
  );
  it.each([
    '00123',
    '2024-01-02',
    '01-02-2024',
    '2024-01-02T03:04:05',
    '2024-01-02T03:04:05Z',
    'true',
    'false',
    '#N/A',
    '-Infinity',
    'Infinity',
    'constructor',
    'toString',
  ])('preserves typed CSV cell.text for %s', async (value) => {
    const actual = await compare(
      Buffer.from(`${header}\n${value},US,${value},Brand,B000000001,1`),
    );
    expect(actual.groupedItems).toHaveLength(
      value === 'constructor' || value === 'toString' ? 0 : 1,
    );
  });
  it.each([
    `${header}\n\n${record}\n\n`,
    `${header}\n"主营,\n组",US,店铺,品牌,b000000001,1\n${record}`,
    `${header}\n${record},,,\n${record}`,
    `${header}\n,CA,,,a,3\n主营组,CA,店铺,品牌,b000000001,1\n${record}`,
    `${header}\n,,,,,`,
  ])(
    'matches whitespace, quoted newlines, wide rows and validation order: %s',
    async (text) => {
      await compare(Buffer.from(text));
    },
  );
  it('rejects a malformed CSV without returning a partial plan', async () => {
    const path = await file(`${header}\n"unclosed`);
    await expect(parseCsvFile(path)).rejects.toMatchObject({
      code: 'invalid',
      message: 'CSV文件无法解析',
    });
    await rename(path, `${path}.released`);
  });
  it.each(['', header])('rejects a missing data row', async (text) => {
    await expect(parseCsvFile(await file(text))).rejects.toThrow(
      '至少需要包含表头和数据行',
    );
  });
  it('checks actual file size before parsing and releases its descriptor', async () => {
    const path = await file('');
    const handle = await open(path, 'r+');
    await handle.truncate(IMPORT_MAX_FILE_BYTES + 1);
    await handle.close();
    await expect(parseCsvFile(path)).rejects.toMatchObject({
      code: 'capacity',
    });
    await rename(path, `${path}.released`);
  });
  it('stops active parsing on cancellation and closes the input stream', async () => {
    const path = await file(
      `${header}\n${Array<string>(20_000).fill(record).join('\n')}`,
    );
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10);
    try {
      await expect(
        parseCsvFile(path, { signal: controller.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      await rename(path, `${path}.released`);
    } finally {
      clearTimeout(timer);
    }
  });
  it('rejects row, column and cell capacity overflow instead of silently truncating', async () => {
    for (const text of [
      `${header}\n${Array<string>(257).fill('x').join(',')}`,
      `${header}\n${'x'.repeat(32768)},US,Shop,Brand,B000000001,1`,
      `${header}\n${Array<string>(100_001).fill(record).join('\n')}`,
    ])
      await expect(parseCsvFile(await file(text))).rejects.toMatchObject({
        code: 'capacity',
      });
  }, 15_000);
});
