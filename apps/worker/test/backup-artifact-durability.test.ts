import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  nativeBackupPublicationSync,
  waitForBackupSync,
} from '../src/backup-artifact-durability';

const dependencies = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('node:fs/promises', () => ({ open: dependencies.open }));
afterEach(() => vi.resetAllMocks());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function handle() {
  return {
    sync: vi.fn(async (): Promise<void> => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe('native backup publication fsync and late completion', () => {
  it('syncs owned files and directory handles and closes both', async () => {
    const file = handle(),
      directory = handle();
    dependencies.open
      .mockResolvedValueOnce(file)
      .mockResolvedValueOnce(directory);
    await nativeBackupPublicationSync.syncFile('owned.dump');
    await nativeBackupPublicationSync.syncDirectory('owned-directory');
    expect(dependencies.open.mock.calls).toEqual([
      ['owned.dump', 'r+'],
      ['owned-directory', 'r'],
    ]);
    expect(file.sync).toHaveBeenCalledOnce();
    expect(file.close).toHaveBeenCalledOnce();
    expect(directory.sync).toHaveBeenCalledOnce();
    expect(directory.close).toHaveBeenCalledOnce();
  });
  it('rejects unsupported directory sync without a compatibility noop or private path', async () => {
    dependencies.open.mockRejectedValue(
      Object.assign(new Error('private-volume-token'), { code: 'EPERM' }),
    );
    await expect(
      waitForBackupSync(
        () => nativeBackupPublicationSync.syncDirectory('private-directory'),
        100,
      ),
    ).rejects.toThrow('BACKUP_PUBLICATION_SYNC_UNCONFIRMED');
  });
  it('closes a handle even when native sync fails', async () => {
    const file = handle();
    file.sync.mockRejectedValue(new Error('private-disk-failure'));
    dependencies.open.mockResolvedValue(file);
    await expect(
      waitForBackupSync(
        () => nativeBackupPublicationSync.syncFile('owned.dump'),
        100,
      ),
    ).rejects.toThrow('BACKUP_PUBLICATION_SYNC_UNCONFIRMED');
    expect(file.close).toHaveBeenCalledOnce();
  });
  it('closes a late-opened handle after its deadline without completing the caller', async () => {
    const late = deferred<ReturnType<typeof handle>>(),
      file = handle();
    dependencies.open.mockReturnValue(late.promise);
    const outcome = waitForBackupSync(
      () => nativeBackupPublicationSync.syncFile('owned.dump'),
      20,
    );
    await expect(outcome).rejects.toThrow(
      'BACKUP_PUBLICATION_SYNC_UNCONFIRMED',
    );
    late.resolve(file);
    await vi.waitFor(() => expect(file.close).toHaveBeenCalledOnce(), {
      interval: 5,
    });
    expect(file.sync).toHaveBeenCalledOnce();
    await expect(outcome).rejects.toThrow(
      'BACKUP_PUBLICATION_SYNC_UNCONFIRMED',
    );
  });
  it.each(['deadline', 'shutdown'] as const)(
    'keeps a %s failure after a late native sync and closes its handle',
    async (kind) => {
      const late = deferred<void>(),
        file = handle(),
        controller = new AbortController();
      file.sync.mockReturnValue(late.promise);
      dependencies.open.mockResolvedValue(file);
      const outcome = waitForBackupSync(
        () => nativeBackupPublicationSync.syncFile('owned.dump'),
        kind === 'deadline' ? 20 : 500,
        controller.signal,
      );
      if (kind === 'shutdown') {
        await vi.waitFor(() => expect(file.sync).toHaveBeenCalledOnce(), {
          interval: 5,
        });
        controller.abort();
      }
      await expect(outcome).rejects.toThrow(
        'BACKUP_PUBLICATION_SYNC_UNCONFIRMED',
      );
      expect(file.close).not.toHaveBeenCalled();
      late.resolve();
      await vi.waitFor(() => expect(file.close).toHaveBeenCalledOnce(), {
        interval: 5,
      });
      await expect(outcome).rejects.toThrow(
        'BACKUP_PUBLICATION_SYNC_UNCONFIRMED',
      );
    },
  );
  it('never opens a file for a pre-aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      waitForBackupSync(
        () => nativeBackupPublicationSync.syncFile('owned.dump'),
        100,
        controller.signal,
      ),
    ).rejects.toThrow('BACKUP_PUBLICATION_SYNC_UNCONFIRMED');
    expect(dependencies.open).not.toHaveBeenCalled();
  });
});
