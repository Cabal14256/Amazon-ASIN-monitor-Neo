import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deleteBackupFile,
  listBackupFiles,
  resolveBackupPath,
} from '../src/backup/backup-files';

describe('backup file boundary', () => {
  it('lists only Neo custom artifacts and rejects traversal', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'neo-backup-files-'));
    try {
      await mkdir(join(directory, 'nested'));
      await writeFile(
        join(directory, 'backup_20260927-020000-abcdef01-primary.dump'),
        'PGDMPdata',
      );
      const filename = 'backup_20260927-020000-abcdef01-primary.dump';
      const metadataPath = join(directory, `${filename}.meta.json`);
      await writeFile(
        metadataPath,
        JSON.stringify({
          version: 1,
          filename,
          target: 'primary',
          sourceEngine: 'postgresql',
        }),
      );
      await writeFile(join(directory, 'legacy.sql'), 'sql');
      await writeFile(
        join(directory, 'backup_20260927-020001-abcdef02-primary.dump'),
        'not-a-custom-dump',
      );
      expect(await listBackupFiles(directory)).toMatchObject([
        { filename, sourceEngine: 'postgresql', restoreSupported: false },
      ]);
      expect(() => resolveBackupPath(directory, '../legacy.sql')).toThrow();
      await expect(
        deleteBackupFile(directory, '../legacy.sql'),
      ).rejects.toThrow();
      await deleteBackupFile(directory, filename);
      await expect(readFile(metadataPath)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
