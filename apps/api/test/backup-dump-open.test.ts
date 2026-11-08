import { backupArtifactMetadataSchema } from '@asin-monitor/contracts';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backupBundle } from '../src/backup/backup-bundle';
import { inspectBackupFile } from '../src/backup/backup-files';

const attack = vi.hoisted(() => ({ path: '', fifo: false }));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      if (String(args[0]) === attack.path) {
        attack.path = '';
        await actual.rename(args[0], `${String(args[0])}.original`);
        if (attack.fifo) execFileSync('mkfifo', [String(args[0])]);
        else await actual.writeFile(args[0], 'PGDMPunchecked-replacement');
      }
      return actual.open(...args);
    },
  };
});
let directory: string | undefined;
afterEach(async () => {
  attack.path = '';
  attack.fifo = false;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});
describe('dump preflight and bundle reject replaced nonregular descriptors', () => {
  for (const method of ['preflight', 'bundle'] as const) {
    it.each(['replacement', ...(process.platform === 'win32' ? [] : ['fifo'])])(
      `${method} rejects a %s substituted immediately before the actual open`,
      async (mode) => {
        directory = await mkdtemp(join(tmpdir(), 'neo-dump-open-'));
        const filename = 'backup_20260927-020000-abcdef01-primary.dump';
        const path = join(directory, filename);
        await writeFile(path, 'PGDMPoriginal-fixture');
        attack.path = path;
        attack.fifo = mode === 'fifo';
        const metadata = backupArtifactMetadataSchema.parse({
          version: 2,
          filename,
          target: 'primary',
          sourceEngine: 'postgresql',
        });
        await expect(
          method === 'preflight'
            ? inspectBackupFile(path)
            : backupBundle(path, filename, metadata),
        ).rejects.toThrow();
        expect(attack.path).toBe('');
      },
      1500,
    );
  }
});
