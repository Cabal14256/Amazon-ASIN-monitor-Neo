import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExportArtifactStore } from '../src/storage';

const taskId = '10000000-0000-4000-8000-000000000166';
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'neo-export-artifact-'));
  directories.push(directory);
  return { directory, store: new ExportArtifactStore(directory) };
}
const content = Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);

describe('export artifacts', () => {
  it('publishes only a task-owned final file and verifies its digest', async () => {
    const { directory, store } = await fixture();
    const { path, stream } = await store.temporary(taskId);
    await new Promise<void>((resolve, reject) =>
      stream.end(content, (error?: Error) =>
        error ? reject(error) : resolve(),
      ),
    );
    const ref = await store.publish(taskId, path, new AbortController().signal);
    expect(ref).toMatchObject({
      taskId,
      key: `export-${taskId}.xlsx`,
      bytes: 8,
    });
    expect(await store.verifiedPath(ref, new AbortController().signal)).toBe(
      join(directory, ref.key),
    );
    await store.discard(path);
    expect(await readFile(join(directory, ref.key))).toEqual(content);
    await writeFile(join(directory, ref.key), Buffer.from('PK\x03\x04bad'));
    await expect(
      store.verifiedPath(ref, new AbortController().signal),
    ).rejects.toThrow();
  });

  it('rejects an outside temporary path and a foreign task reference', async () => {
    const { store } = await fixture();
    await expect(
      store.publish(
        taskId,
        join(tmpdir(), 'foreign.part'),
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    await expect(
      store.verifiedPath(
        {
          taskId,
          key: '../outside.xlsx',
          bytes: 8,
          sha256: 'a'.repeat(64),
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  });

  it('removes only the final artifact belonging to the specified task', async () => {
    const { directory, store } = await fixture();
    const { path, stream } = await store.temporary(taskId);
    await new Promise<void>((resolve) => stream.end(content, resolve));
    await store.publish(taskId, path, new AbortController().signal);
    await expect(store.discardFinal('../outside')).rejects.toThrow();
    await store.discardFinal(taskId);
    expect(await store.read(taskId)).toBeNull();
    expect(await readFile(path)).toEqual(content);
    await store.discard(path);
    expect(
      await readFile(join(directory, `export-${taskId}.xlsx`)).catch(
        () => null,
      ),
    ).toBeNull();
  });

  it('never publishes a truncated or non-zip partial under the final name', async () => {
    const { directory, store } = await fixture();
    const partial = await store.temporary(taskId);
    await new Promise<void>((resolve) =>
      partial.stream.end('invalid', resolve),
    );
    await expect(
      store.publish(taskId, partial.path, new AbortController().signal),
    ).rejects.toThrow();
    expect(await store.read(taskId)).toBeNull();
    await store.discard(partial.path);
    expect(
      await readFile(join(directory, `export-${taskId}.xlsx`)).catch(
        () => null,
      ),
    ).toBeNull();
  });
});
