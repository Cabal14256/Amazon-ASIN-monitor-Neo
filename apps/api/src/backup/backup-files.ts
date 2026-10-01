import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  unlink,
} from 'node:fs/promises';
import { basename, resolve, sep } from 'node:path';

import {
  BACKUP_ARTIFACT_METADATA_MAX_BYTES,
  backupArtifactMetadataSchema,
  backupFileSchema,
  type BackupDatabaseSettings,
  type BackupFile,
  type BackupTarget,
} from '@asin-monitor/contracts';

/** Only files produced by the Neo worker are addressable through HTTP. */
export const BACKUP_FILENAME_PATTERN =
  /^backup_[0-9]{8}-[0-9]{6}-[a-f0-9]{8}-(primary|competitor)\.dump$/;

export function backupFilenameTarget(filename: string): BackupTarget {
  const match = BACKUP_FILENAME_PATTERN.exec(filename);
  if (!match) throw new Error('BACKUP_FILENAME_INVALID');
  return match[1] as BackupTarget;
}

function safeBackupPath(directory: string, filename: string): string {
  if (basename(filename) !== filename)
    throw new Error('BACKUP_FILENAME_INVALID');
  backupFilenameTarget(filename);
  const root = resolve(directory);
  const path = resolve(root, filename);
  if (path !== root && !path.startsWith(`${root}${sep}`))
    throw new Error('BACKUP_PATH_INVALID');
  return path;
}

export async function ensureBackupDirectory(directory: string): Promise<void> {
  await mkdir(resolve(directory), { recursive: true });
}

export function resolveBackupPath(directory: string, filename: string): string {
  return safeBackupPath(directory, filename);
}

export async function inspectBackupFile(path: string) {
  const details = await lstat(path);
  if (!details.isFile() || details.size < 5)
    throw new Error('BACKUP_ARTIFACT_INVALID');
  const file = await open(path, 'r');
  try {
    const header = Buffer.alloc(5);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    if (bytesRead !== 5 || header.toString('ascii') !== 'PGDMP')
      throw new Error('BACKUP_ARTIFACT_INVALID');
  } finally {
    await file.close();
  }
  return details;
}

export async function readBackupMetadata(directory: string, filename: string) {
  const target = backupFilenameTarget(filename);
  try {
    const path = `${safeBackupPath(directory, filename)}.meta.json`;
    const details = await lstat(path);
    if (!details.isFile() || details.size > BACKUP_ARTIFACT_METADATA_MAX_BYTES)
      return null;
    const parsed = backupArtifactMetadataSchema.safeParse(
      JSON.parse(await readFile(path, 'utf8')),
    );
    return parsed.success &&
      parsed.data.filename === filename &&
      parsed.data.target === target
      ? parsed.data
      : null;
  } catch {
    return null;
  }
}

export async function listBackupFiles(
  directory: string,
): Promise<(BackupFile & { databaseSettings?: BackupDatabaseSettings })[]> {
  await ensureBackupDirectory(directory);
  const entries = await readdir(resolve(directory), { withFileTypes: true });
  const files: (BackupFile & { databaseSettings?: BackupDatabaseSettings })[] =
    [];
  for (const entry of entries) {
    if (!entry.isFile() || !BACKUP_FILENAME_PATTERN.test(entry.name)) continue;
    const path = safeBackupPath(directory, entry.name);
    let details;
    try {
      details = await inspectBackupFile(path);
    } catch {
      continue;
    }
    const target = backupFilenameTarget(entry.name);
    const metadata = await readBackupMetadata(directory, entry.name);
    files.push({
      ...backupFileSchema.parse({
        filename: entry.name,
        size: details.size,
        createdAt: details.birthtime.toISOString(),
        target,
        format: 'custom',
        sourceEngine: metadata?.sourceEngine,
        description:
          metadata && metadata.version !== 1 ? metadata.description : undefined,
        metadataVersion: metadata?.version,
        scope: metadata?.version === 3 ? metadata.scope : undefined,
        sourceExtensionVersion:
          (metadata?.version === 2 || metadata?.version === 4) &&
          metadata.sourceEngine === 'timescaledb'
            ? metadata.timescale.extensionVersion
            : undefined,
      }),
      databaseSettings:
        metadata && 'databaseSettings' in metadata
          ? metadata.databaseSettings
          : undefined,
    });
  }
  return files.sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

export async function deleteBackupFile(
  directory: string,
  filename: string,
): Promise<void> {
  const path = safeBackupPath(directory, filename);
  await unlink(path);
  await unlink(`${path}.meta.json`).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}
