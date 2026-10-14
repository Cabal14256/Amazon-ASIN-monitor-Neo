import { open } from 'node:fs/promises';

export interface BackupPublicationSync {
  syncFile(path: string): Promise<void>;
  syncDirectory(path: string): Promise<void>;
}

async function syncPath(path: string, flags: string) {
  const handle = await open(path, flags);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Unsupported directory fsync is a failed durability guarantee, never a noop.
 * The native operation retains and closes its own handle after a late finish. */
export const nativeBackupPublicationSync: BackupPublicationSync = {
  syncFile: (path) => syncPath(path, 'r+'),
  syncDirectory: (path) => syncPath(path, 'r'),
};

/** Stop waiting on shutdown/deadline without treating late sync as completion. */
export async function waitForBackupSync(
  operation: () => Promise<void>,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error('BACKUP_PUBLICATION_SYNC_UNCONFIRMED');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    const fail = () => reject(new Error('BACKUP_PUBLICATION_SYNC_UNCONFIRMED'));
    timer = setTimeout(fail, Math.min(30_000, Math.max(1, timeoutMs)));
    timer.unref();
    onAbort = fail;
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  try {
    await Promise.race([
      Promise.resolve().then(() => {
        if (signal?.aborted)
          throw new Error('BACKUP_PUBLICATION_SYNC_UNCONFIRMED');
        return operation();
      }),
      interrupted,
    ]);
  } catch {
    throw new Error('BACKUP_PUBLICATION_SYNC_UNCONFIRMED');
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
  }
}
