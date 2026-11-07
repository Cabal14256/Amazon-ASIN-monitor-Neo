import { execFileSync } from 'node:child_process';
import { appendFile, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  readBackupArtifactMetadataFile,
  restoreCommandArgs,
} from '../src/backup-processor';

const hooks = vi.hoisted(() => ({
  afterStat: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return {
    ...actual,
    lstat: async (...args: Parameters<typeof actual.lstat>) => {
      const details = await Reflect.apply(actual.lstat, actual, args);
      const hook = hooks.afterStat;
      hooks.afterStat = undefined;
      await hook?.();
      return details;
    },
  };
});
let directory: string | undefined;
afterEach(async () => {
  hooks.afterStat = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});
const metadata = {
  version: 2,
  filename: 'backup_20260927-020000-abcdef01-primary.dump',
  target: 'primary',
  sourceEngine: 'postgresql',
  databaseSettings: {
    encoding: 'UTF8',
    lcCollate: 'C',
    lcCtype: 'C',
    localeProvider: 'libc',
  },
};
describe('Worker metadata uses a bounded validated file descriptor', () => {
  it.each(['replace', 'grow'] as const)(
    'rejects a valid sidecar that changes after lstat (%s)',
    async (mode) => {
      directory = await mkdtemp(join(tmpdir(), 'neo-worker-sidecar-'));
      const path = join(directory, 'backup.meta.json');
      await writeFile(path, JSON.stringify(metadata));
      hooks.afterStat = async () => {
        if (mode === 'grow') await appendFile(path, ' '.repeat(1024));
        else {
          await rename(path, `${path}.original`);
          await writeFile(path, JSON.stringify(metadata));
        }
      };
      await expect(readBackupArtifactMetadataFile(path)).rejects.toThrow(
        'BACKUP_METADATA_INVALID',
      );
    },
  );
  it('quotes libpq conninfo metacharacters as a single literal database value', () => {
    expect(
      restoreCommandArgs('dbname=competitor', '/tmp/fixture.dump', 'backup'),
    ).toContain("--dbname=dbname='dbname=competitor'");
    expect(
      restoreCommandArgs(
        "space ' slash \\ database",
        '/tmp/fixture.dump',
        'backup',
      ),
    ).toContain("--dbname=dbname='space \\' slash \\\\ database'");
  });
  it.skipIf(process.platform === 'win32')(
    'rejects a FIFO substituted after lstat without blocking the Worker',
    async () => {
      directory = await mkdtemp(join(tmpdir(), 'neo-worker-fifo-'));
      const path = join(directory, 'backup.meta.json');
      await writeFile(path, JSON.stringify(metadata));
      hooks.afterStat = async () => {
        await rename(path, `${path}.original`);
        execFileSync('mkfifo', [path]);
      };
      await expect(readBackupArtifactMetadataFile(path)).rejects.toThrow(
        'BACKUP_METADATA_INVALID',
      );
    },
    1500,
  );
});
