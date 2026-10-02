import { BACKUP_ARTIFACT_METADATA_MAX_BYTES } from '@asin-monitor/contracts';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  deleteBackupFile,
  listBackupFiles,
  readBackupMetadata,
  resolveBackupPath,
} from '../src/backup/backup-files';

describe('backup file boundary', () => {
  it('addresses the complete task UUID and preserves older eight-digit filenames', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'neo-backup-files-'));
    const filenames = [
      'backup_20261002-020000-10000000000040008000000000000161-primary.dump',
      'backup_20261002-020001-abcdef01-competitor.dump',
    ];
    try {
      for (const filename of filenames) {
        await writeFile(join(directory, filename), 'PGDMPfixture');
        expect(resolveBackupPath(directory, filename)).toBe(
          join(directory, filename),
        );
      }
      expect(
        (await listBackupFiles(directory)).map((file) => file.filename).sort(),
      ).toEqual(filenames.sort());
      expect(() =>
        resolveBackupPath(directory, `../${filenames[0]}`),
      ).toThrow();
      expect(() =>
        resolveBackupPath(directory, `${filenames[0]}.partial`),
      ).toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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

  it('accepts a valid Timescale manifest larger than the old 4 KiB cap', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'neo-backup-files-'));
    const filename = 'backup_20260927-020000-abcdef01-primary.dump';
    try {
      const metadata = {
        version: 2,
        filename,
        target: 'primary',
        sourceEngine: 'timescaledb',
        databaseSettings: {
          encoding: 'UTF8',
          lcCollate: 'C.UTF-8',
          lcCtype: 'C.UTF-8',
          localeProvider: 'libc',
        },
        timescale: {
          extensionVersion: '2.22.0',
          hypertables: Array.from(
            { length: 100 },
            (_, index) => `public.table_${index}_${'x'.repeat(80)}`,
          ),
          continuousAggregates: [],
        },
      };
      const serialized = JSON.stringify(metadata);
      expect(Buffer.byteLength(serialized)).toBeGreaterThan(4096);
      expect(Buffer.byteLength(serialized)).toBeLessThan(
        BACKUP_ARTIFACT_METADATA_MAX_BYTES,
      );
      await writeFile(join(directory, `${filename}.meta.json`), serialized);
      expect(await readBackupMetadata(directory, filename)).toEqual(metadata);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('returns the bounded description stored in a v2 sidecar', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'neo-backup-files-'));
    const filename = 'backup_20260927-020000-abcdef01-primary.dump';
    try {
      await writeFile(join(directory, filename), 'PGDMPfixture');
      await writeFile(
        join(directory, `${filename}.meta.json`),
        JSON.stringify({
          version: 2,
          filename,
          target: 'primary',
          sourceEngine: 'postgresql',
          description: 'automated recovery point',
        }),
      );
      expect(await listBackupFiles(directory)).toMatchObject([
        { filename, description: 'automated recovery point' },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
