import { randomUUID } from 'node:crypto';
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { IMPORT_MAX_FILE_BYTES } from '../src/csv';
import {
  ImportFileStore,
  importFileType,
  isImportFileReference,
  type ImportFileReference,
} from '../src/files';

const stores: ImportFileStore[] = [];
async function store() {
  const directory = await mkdtemp(join(tmpdir(), 'neo-import-storage-'));
  const instance = new ImportFileStore(directory);
  stores.push(instance);
  return instance;
}
afterEach(async () => {
  for (const instance of stores.splice(0)) {
    await instance.close();
    await rm(instance.directory, { recursive: true, force: true });
  }
});
const signal = () => AbortSignal.timeout(2000);
describe('persistent import handoff files', () => {
  it('publishes a complete file once and verifies its bytes from another store instance', async () => {
    const instance = await store();
    const reference = await instance.save(
      Readable.from(['part1', 'part2']),
      randomUUID(),
      'C:\\user\\表格.CSV',
      'text/csv',
      signal(),
    );
    expect(reference.originalFilename).toBe('表格.CSV');
    expect(reference.bytes).toBe(10);
    expect(isImportFileReference(reference)).toBe(true);
    expect(await readdir(instance.directory)).toEqual([
      `import-${reference.taskId}.csv`,
    ]);
    const consumer = new ImportFileStore(instance.directory);
    try {
      const path = await consumer.verifiedPath(reference, signal());
      expect(await readFile(path, 'utf8')).toBe('part1part2');
      await consumer.remove(reference);
      await consumer.remove(reference);
      expect(await readdir(instance.directory)).toEqual([]);
    } finally {
      await consumer.close();
    }
  });
  it('rejects wrong size or hash before parsing an altered file', async () => {
    const instance = await store();
    const reference = await instance.save(
      Readable.from(['original']),
      randomUUID(),
      'file.csv',
      'text/csv',
      signal(),
    );
    const path = await instance.verifiedPath(reference, signal());
    await writeFile(path, 'modified');
    await expect(instance.verifiedPath(reference, signal())).rejects.toThrow(
      '内容已改变',
    );
    await writeFile(path, 'x');
    await expect(instance.verifiedPath(reference, signal())).rejects.toThrow(
      '内容已改变',
    );
  });
  it('never overwrites a published task file on an ID collision', async () => {
    const instance = await store();
    const id = randomUUID();
    const first = await instance.save(
      Readable.from(['first']),
      id,
      'file.csv',
      'text/csv',
      signal(),
    );
    await expect(
      instance.save(
        Readable.from(['second']),
        id,
        'file.csv',
        'text/csv',
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(
      await readFile(await instance.verifiedPath(first, signal()), 'utf8'),
    ).toBe('first');
    expect(await readdir(instance.directory)).toHaveLength(1);
  });
  it('cleans partially uploaded files when size or input errors interrupt writing', async () => {
    const instance = await store();
    await expect(
      instance.save(
        Readable.from([Buffer.alloc(IMPORT_MAX_FILE_BYTES + 1)]),
        randomUUID(),
        'file.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'capacity' });
    const broken = Readable.from(
      (async function* () {
        yield Buffer.from('partial');
        throw new Error('fixture input stopped');
      })(),
    );
    await expect(
      instance.save(broken, randomUUID(), 'file.csv', 'text/csv', signal()),
    ).rejects.toThrow('fixture input stopped');
    expect(await readdir(instance.directory)).toEqual([]);
  });
  it('cleans an upload interrupted by cancellation', async () => {
    const instance = await store();
    const controller = new AbortController();
    const input = new Readable({
      read() {
        this.push(Buffer.alloc(1024));
        controller.abort();
      },
    });
    await expect(
      instance.save(
        input,
        randomUUID(),
        'file.csv',
        'text/csv',
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(await readdir(instance.directory)).toEqual([]);
  });
  it('validates extension/MIME and prevents reference path traversal', async () => {
    const instance = await store();
    for (const filename of ['file.xls', 'file.exe', 'x'.repeat(256) + '.csv'])
      expect(() => importFileType(filename, 'text/csv')).toThrow('只支持');
    expect(() => importFileType('file.csv', 'text/plain')).toThrow('只支持');
    await expect(
      instance.remove({ taskId: '../secret', extension: 'csv' }),
    ).rejects.toThrow('引用无效');
    expect(isImportFileReference({ taskId: '../secret' })).toBe(false);
    expect(await readdir(instance.directory)).toEqual([]);
  });
  it('advances bounded cleanup scans past retained files and preserves unrelated/new files', async () => {
    const instance = await store();
    const files: ImportFileReference[] = [];
    for (let i = 0; i < 5; i++) {
      const file = await instance.save(
        Readable.from(['data']),
        randomUUID(),
        'file.csv',
        'text/csv',
        signal(),
      );
      files.push(file);
      const path = await instance.verifiedPath(file, signal());
      if (i < 4) await utimes(path, new Date(0), new Date(0));
    }
    await writeFile(join(instance.directory, 'unrelated.csv'), 'keep');
    const removed: string[] = [];
    for (let i = 0; i < 8; i++)
      await instance.cleanup({
        olderThan: Date.now() - 1000,
        limit: 1,
        mayRemove: async (id) => {
          if (id === files[0].taskId) return false;
          removed.push(id);
          return true;
        },
      });
    expect(new Set(removed)).toEqual(
      new Set(files.slice(1, 4).map((file) => file.taskId)),
    );
    expect(await readdir(instance.directory)).toHaveLength(3);
  });
  it('waits for an in-flight cleanup before closing its directory handle', async () => {
    const instance = await store();
    const file = await instance.save(
      Readable.from(['data']),
      randomUUID(),
      'file.csv',
      'text/csv',
      signal(),
    );
    await utimes(
      await instance.verifiedPath(file, signal()),
      new Date(0),
      new Date(0),
    );
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const cleanup = instance.cleanup({
      olderThan: Date.now() - 1000,
      mayRemove: async () => {
        entered();
        await pause;
        return false;
      },
    });
    await ready;
    const close = instance.close();
    release();
    await Promise.all([cleanup, close]);
    await expect(
      instance.cleanup({ olderThan: 0, mayRemove: async () => true }),
    ).rejects.toThrow('CLOSED');
  });
});
