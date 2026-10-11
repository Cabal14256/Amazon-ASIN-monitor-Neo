import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { processCommand } from '../src/backup-processor';

function options(signal: AbortSignal, onStarted = vi.fn()) {
  return {
    signal,
    timeoutMs: 2000,
    maxBytes: 1024,
    checkpoint: vi.fn(async () => undefined),
    onProgress: vi.fn(async () => undefined),
    pollIntervalMs: 20,
    onStarted,
  };
}

describe('backup command start is the actual successful ChildProcess spawn event', () => {
  it('never reports an asynchronously failing executable as an in-place restore start', async () => {
    const command = join(tmpdir(), `neo-absent-restore-${randomUUID()}.exe`);
    const callbacks = options(new AbortController().signal);
    await expect(
      processCommand(command, [], { ...process.env }, callbacks),
    ).rejects.toThrow('BACKUP_COMMAND_FAILED');
    expect(callbacks.onStarted).not.toHaveBeenCalled();
  });

  it('reports a real successfully spawned child once and waits for its actual close', async () => {
    const callbacks = options(new AbortController().signal);
    await expect(
      processCommand(
        process.execPath,
        ['-e', 'process.exit(0)'],
        { ...process.env },
        callbacks,
      ),
    ).resolves.toBeUndefined();
    expect(callbacks.onStarted).toHaveBeenCalledOnce();
  });

  it('does not report a start when the original signal was cancelled before spawn', async () => {
    const controller = new AbortController();
    controller.abort();
    const callbacks = options(controller.signal);
    await expect(
      processCommand(
        process.execPath,
        ['-e', 'process.exit(0)'],
        { ...process.env },
        callbacks,
      ),
    ).rejects.toThrow('BACKUP_COMMAND_CANCELLED');
    expect(callbacks.onStarted).not.toHaveBeenCalled();
  });

  it('drains the actual child after a successful-start callback rejects', async () => {
    const callbacks = options(
      new AbortController().signal,
      vi.fn(() => {
        throw new Error('fixture start callback rejected');
      }),
    );
    await expect(
      processCommand(
        process.execPath,
        ['-e', 'setInterval(() => undefined, 1000)'],
        { ...process.env },
        callbacks,
      ),
    ).rejects.toThrow('fixture start callback rejected');
    expect(callbacks.onStarted).toHaveBeenCalledOnce();
  });
});
