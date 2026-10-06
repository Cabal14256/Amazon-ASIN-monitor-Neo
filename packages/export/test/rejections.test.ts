import {
  mkdtemp,
  open,
  readdir,
  rm,
  unlink,
  utimes,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { finished } from 'node:stream/promises';
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
const stores: ExportArtifactStore[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'neo-export-rejection-'));
  directories.push(directory);
  const store = new ExportArtifactStore(directory);
  stores.push(store);
  return { directory, store };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) await store.closeRejectionCursor();
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
  it('retains one physical sweep and its cursor until a pending callback settles during shutdown', async () => {
    const { store } = await fixture();
    await store.recordRejectedSubmission(identity);
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const settle = vi.fn(async () => {
      entered();
      await held;
      return false;
    });
    const first = store.reconcileRejectedSubmissions(1, settle);
    await started;
    const other = vi.fn(async () => true);
    const joined = store.reconcileRejectedSubmissions(1, other);
    let closed = false;
    const closing = store.closeRejectionCursor().then(() => {
      closed = true;
    });
    try {
      await Promise.resolve();
      expect(closed).toBe(false);
      await store.reconcileRejectedSubmissions(1, other);
      expect(other).not.toHaveBeenCalled();
      expect(settle).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await Promise.all([first, joined, closing]);
    }
    expect(closed).toBe(true);
    expect(await store.readRejectedSubmission(identity.taskId)).toEqual(
      identity,
    );
    await store.reconcileRejectedSubmissions(1, other);
    expect(other).not.toHaveBeenCalled();
  });

  it('advances past corrupt receipts and callback failures before revisiting an earlier retained proof', async () => {
    const { directory, store } = await fixture();
    const ids = [
      identity.taskId,
      '20000000-0000-4000-8000-000000000166',
      '30000000-0000-4000-8000-000000000166',
    ];
    for (const taskId of ids)
      await store.recordRejectedSubmission({ ...identity, taskId });
    const ordered = (await readdir(directory)).map((name) =>
      name.slice('export-rejected-'.length, -'.json'.length),
    );
    await writeFile(join(directory, `export-rejected-${ordered[0]}.json`), '{');
    await expect(
      store.reconcileRejectedSubmissions(1, async () => true),
    ).rejects.toThrow();
    const failing = vi.fn(async () => {
      throw new Error('fixture reconciliation unavailable');
    });
    await expect(
      store.reconcileRejectedSubmissions(1, failing),
    ).rejects.toThrow('fixture reconciliation unavailable');
    expect(failing).toHaveBeenCalledWith({ ...identity, taskId: ordered[1] });
    const later = vi.fn(async () => true);
    await store.reconcileRejectedSubmissions(1, later);
    expect(later).toHaveBeenCalledWith({ ...identity, taskId: ordered[2] });
    expect(await store.readRejectedSubmission(ordered[2]!)).toBeNull();
    expect(await readdir(directory)).toHaveLength(2);
  });

  it('protects a physically pending journal from the crashed-workbook partial sweep', async () => {
    const { directory, store } = await fixture();
    const probePath = join(directory, 'handle-prototype');
    const probe = await open(probePath, 'wx');
    const prototype = Object.getPrototypeOf(probe);
    const originalSync: FileHandle['sync'] = prototype.sync;
    await probe.close();
    await unlink(probePath);
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.spyOn(prototype, 'sync').mockImplementationOnce(async function (
      this: FileHandle,
    ) {
      entered();
      await held;
      await originalSync.call(this);
    });
    const recording = store.recordRejectedSubmission(identity);
    try {
      await started;
      const journalName = (await readdir(directory))[0]!;
      const journalPath = join(directory, journalName);
      const workbook = await store.temporary(
        '20000000-0000-4000-8000-000000000166',
      );
      workbook.stream.end(Buffer.from([0x50, 0x4b, 3, 4]));
      await finished(workbook.stream);
      const old = new Date('2000-01-01T00:00:00.000Z');
      await utimes(journalPath, old, old);
      await utimes(workbook.path, old, old);
      expect(
        await store.cleanup(
          Date.now() - 45 * 60_000,
          100,
          async (_id, kind) => kind === 'partial',
        ),
      ).toBe(1);
      expect(await readdir(directory)).toContain(journalName);
    } finally {
      release();
      await recording;
    }
    expect(await store.readRejectedSubmission(identity.taskId)).toEqual(
      identity,
    );
    expect(await readdir(directory)).toEqual([
      `export-rejected-${identity.taskId}.json`,
    ]);
  });

  it('reaches later committed tasks even when the first hundred receipts must be retained', async () => {
    const { directory, store } = await fixture();
    for (let index = 1; index <= 205; index++) {
      const taskId = `10000000-0000-4000-8000-${index
        .toString(16)
        .padStart(12, '0')}`;
      await writeFile(
        join(directory, `export-rejected-${taskId}.json`),
        JSON.stringify({ ...identity, taskId }),
      );
    }
    const names = await readdir(directory);
    const laterId = names[names.length - 1]!.slice(
      'export-rejected-'.length,
      -'.json'.length,
    );
    const seen = new Set<string>();
    for (let sweep = 0; sweep < 4; sweep++) {
      let inspected = 0;
      await store.reconcileRejectedSubmissions(100, async (proof) => {
        inspected++;
        seen.add(proof.taskId);
        return proof.taskId === laterId;
      });
      expect(inspected).toBeLessThanOrEqual(100);
    }
    expect(seen.size).toBe(205);
    expect(await store.readRejectedSubmission(laterId)).toBeNull();
    expect(await readdir(directory)).toHaveLength(204);
  });

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
