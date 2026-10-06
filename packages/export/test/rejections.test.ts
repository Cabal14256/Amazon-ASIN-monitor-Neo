import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExportArtifactStore } from '../src/storage';

const identity = {
  taskId: '10000000-0000-4000-8000-000000000166',
  userId: 'fixture-owner',
  createdAt: '2026-10-07T00:00:00.000Z',
  taskType: 'export' as const,
  taskSubType: 'asin' as const,
};
const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'neo-export-rejection-'));
  directories.push(directory);
  return { directory, store: new ExportArtifactStore(directory) };
}
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (
      dirname(directory) !== resolve(tmpdir()) ||
      !basename(directory).startsWith('neo-export-rejection-')
    )
      throw new Error('Invalid rejection fixture cleanup');
    await rm(directory, { recursive: true, force: true });
  }
});

describe('private immutable export rejection journal', () => {
  it('survives store recreation, tolerates matching replay and cannot replace another creation identity', async () => {
    const { directory, store } = await fixture();
    await store.recordRejectedSubmission(identity);
    const recreated = new ExportArtifactStore(directory);
    expect(await recreated.readRejectedSubmission(identity.taskId)).toEqual(
      identity,
    );
    await recreated.recordRejectedSubmission(identity);
    await expect(
      recreated.recordRejectedSubmission({
        ...identity,
        userId: 'foreign-owner',
      }),
    ).rejects.toThrow();
    expect(await recreated.readRejectedSubmission(identity.taskId)).toEqual(
      identity,
    );
    expect(await readdir(directory)).toEqual([
      `export-rejected-${identity.taskId}.json`,
    ]);
    expect(await recreated.read(identity.taskId)).toBeNull();
  });

  it('retains receipts while Redis reconciliation is unavailable and removes only those terminally settled', async () => {
    const { store } = await fixture();
    await store.recordRejectedSubmission(identity);
    const settle = vi.fn(async () => {
      throw new Error('fixture Redis unavailable');
    });
    await expect(
      store.reconcileRejectedSubmissions(100, settle),
    ).rejects.toThrow('fixture Redis unavailable');
    expect(await store.readRejectedSubmission(identity.taskId)).toEqual(
      identity,
    );
    await store.reconcileRejectedSubmissions(100, async (proof) => {
      expect(proof).toEqual(identity);
      return false;
    });
    expect(await store.readRejectedSubmission(identity.taskId)).toEqual(
      identity,
    );
    await store.reconcileRejectedSubmissions(100, async () => true);
    expect(await store.readRejectedSubmission(identity.taskId)).toBeNull();
  });

  it('rejects foreign identity, malformed JSON, oversized and non-task-owned names without touching neighbouring files', async () => {
    const { directory, store } = await fixture();
    const path = join(directory, `export-rejected-${identity.taskId}.json`);
    await writeFile(
      path,
      JSON.stringify({
        ...identity,
        taskId: '20000000-0000-4000-8000-000000000166',
      }),
    );
    await expect(
      store.readRejectedSubmission(identity.taskId),
    ).rejects.toThrow();
    await writeFile(path, '{');
    await expect(
      store.readRejectedSubmission(identity.taskId),
    ).rejects.toThrow();
    await writeFile(path, 'x'.repeat(4097));
    await expect(
      store.readRejectedSubmission(identity.taskId),
    ).rejects.toThrow();
    await expect(store.readRejectedSubmission('../outside')).rejects.toThrow();
    await writeFile(join(directory, 'operator-notes.json'), 'keep');
    await store.discardRejectedSubmission(identity.taskId);
    await store.reconcileRejectedSubmissions(100, async () => true);
    expect(await readdir(directory)).toEqual(['operator-notes.json']);
  });
});
