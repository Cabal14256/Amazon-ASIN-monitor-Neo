import { BACKUP_ARTIFACT_METADATA_MAX_BYTES } from '@asin-monitor/contracts';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
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
  it('uses the delayed dump window from its sidecar across file transfer and identifies historical fallback sources', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'neo-backup-files-'));
    const filename =
      'backup_20261001-080000-10000000000040008000000000000161-primary.dump';
    const execution = {
      timeSource: 'dump-start',
      dumpStartedAt: '2026-10-03T01:00:00.123Z',
      dumpCompletedAt: '2026-10-03T01:02:00.456Z',
      publicationStartedAt: '2026-10-03T01:03:00.789Z',
    };
    try {
      await writeFile(join(directory, filename), 'PGDMPfixture');
      await writeFile(
        join(directory, `${filename}.meta.json`),
        JSON.stringify({
          version: 3,
          filename,
          target: 'primary',
          sourceEngine: 'postgresql',
          scope: 'full',
          archiveSha256: 'a'.repeat(64),
          databaseSettings: {
            encoding: 'UTF8',
            lcCollate: 'C',
            lcCtype: 'C',
            localeProvider: 'libc',
          },
          execution,
        }),
      );
      await utimes(join(directory, filename), new Date(), new Date());
      expect(await listBackupFiles(directory)).toMatchObject([
        {
          filename,
          createdAt: execution.dumpStartedAt,
          timeSource: 'dump-start',
          execution,
        },
      ]);
      const old = 'backup_20261002-000000-abcdef01-primary.dump';
      const invalidDate = 'backup_20260230-000000-abcdef02-primary.dump';
      await writeFile(join(directory, old), 'PGDMPfixture');
      await writeFile(join(directory, invalidDate), 'PGDMPfixture');
      const files = await listBackupFiles(directory);
      expect(files.find((row) => row.filename === old)).toMatchObject({
        timeSource: 'filename',
        createdAt: '2026-10-01T16:00:00.000Z',
      });
      expect(files.find((row) => row.filename === invalidDate)).toMatchObject({
        timeSource: 'mtime',
      });
      expect(
        files.find((row) => row.filename === old)?.execution,
      ).toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('retains the Shanghai filename recovery point when an old archive is extracted today', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'neo-backup-files-'));
    const filenames = [
      'backup_20260927-020000-abcdef01-primary.dump',
      'backup_20260928-000000-10000000000040008000000000000161-primary.dump',
      'backup_20260929-240000-abcdef03-primary.dump',
    ];
    try {
      for (const filename of filenames) {
        await writeFile(join(directory, filename), 'PGDMPfixture');
        // A transferred tar can retain mtime while the new filesystem assigns
        // today's birthtime. Neither should replace the immutable filename.
        await utimes(
          join(directory, filename),
          new Date(),
          new Date('2026-09-01T00:00:00Z'),
        );
      }
      expect(
        (await listBackupFiles(directory)).map(({ filename, createdAt }) => ({
          filename,
          createdAt,
        })),
      ).toEqual([
        { filename: filenames[2], createdAt: '2026-09-28T16:00:00.000Z' },
        { filename: filenames[1], createdAt: '2026-09-27T16:00:00.000Z' },
        { filename: filenames[0], createdAt: '2026-09-26T18:00:00.000Z' },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('uses preserved mtime for an older filename with an invalid calendar stamp', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'neo-backup-files-'));
    const filename = 'backup_20260230-020000-abcdef01-primary.dump';
    try {
      await writeFile(join(directory, filename), 'PGDMPfixture');
      const recoveryPoint = new Date('2026-02-28T18:00:00.000Z');
      await utimes(join(directory, filename), recoveryPoint, recoveryPoint);
      expect(await listBackupFiles(directory)).toMatchObject([
        { filename, createdAt: recoveryPoint.toISOString() },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it('keeps expected absent, malformed and schema-invalid sidecars unrestorable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'neo-backup-files-'));
    const filename = 'backup_20260927-020000-abcdef01-primary.dump';
    try {
      expect(await readBackupMetadata(directory, filename)).toBeNull();
      for (const content of [
        '{broken JSON',
        JSON.stringify({ version: 3, filename }),
      ]) {
        await writeFile(join(directory, `${filename}.meta.json`), content);
        expect(await readBackupMetadata(directory, filename)).toBeNull();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
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
