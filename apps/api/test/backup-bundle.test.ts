import { backupArtifactMetadataSchema } from '@asin-monitor/contracts';
import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import { backupBundle } from '../src/backup/backup-bundle';

describe('backup download bundle', () => {
  it('is a standard tar with the dump and restore sidecar', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'neo-backup-bundle-'));
    const filename = 'backup_20260927-020000-abcdef01-primary.dump';
    try {
      const dump = Buffer.from('PGDMPfixture');
      const path = join(directory, filename);
      const archive = join(directory, 'download.tar');
      const metadata = backupArtifactMetadataSchema.parse({
        version: 2,
        filename,
        target: 'primary',
        sourceEngine: 'postgresql',
        description: 'nightly backup',
      });
      await writeFile(path, dump);
      await pipeline(
        await backupBundle(path, filename, metadata),
        createWriteStream(archive),
      );
      const entries = execFileSync('tar', ['-tf', archive], {
        encoding: 'utf8',
      })
        .trim()
        .split(/\r?\n/);
      expect(entries).toEqual([filename, `${filename}.meta.json`]);
      expect(execFileSync('tar', ['-xOf', archive, filename])).toEqual(dump);
      const sidecar = execFileSync('tar', [
        '-xOf',
        archive,
        `${filename}.meta.json`,
      ]);
      expect(JSON.parse(sidecar.toString('utf8'))).toEqual(metadata);
      expect((await readFile(archive)).length % 512).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
