import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackupService } from '../src/backup/backup.service';

const principal = { userId: 'backup-admin', sessionId: 'session-1' } as never;
const createdAt = '2026-09-27T00:00:00.000Z';
const filename = 'backup_20260927-020000-abcdef01-primary.dump';
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'neo-backup-service-'));
  directories.push(directory);
  const unit = {
    lockOperator: vi.fn(async () => ({
      status: 'ACTIVE',
      lockedUntil: null,
      forcePasswordChange: false,
      passwordExpiresAt: null,
    })),
    lockSession: vi.fn(async () => ({ status: 'ACTIVE', expiresAt: null })),
    operatorPermissionCodes: vi.fn(async () => ['settings:write']),
  };
  const repository = {
    transaction: vi.fn(async (operation: (value: typeof unit) => unknown) =>
      operation(unit),
    ),
  };
  const port = {
    store: {
      create: vi.fn(async (input: { taskId: string }) => ({
        ...input,
        createdAt,
      })),
    },
    enqueue: vi.fn(async () => undefined),
  };
  const tasks = { openBackup: vi.fn(() => port) };
  const service = new BackupService(
    {
      AUTH_DATA_AUTHORITY: 'postgresql',
      BACKUP_STORAGE_DIRECTORY: directory,
    } as never,
    repository as never,
    tasks as never,
    { info: vi.fn(), error: vi.fn() } as never,
  );
  return { directory, unit, port, tasks, service };
}

describe('backup API service', () => {
  it('creates an authorized asynchronous task with no connection credentials in the payload', async () => {
    const { service, port } = await fixture();
    const result = await service.create(principal, {
      target: 'primary',
      useAsync: true,
    });
    expect(result).toMatchObject({ status: 'pending' });
    expect(port.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: result.taskId,
        operation: 'create',
        target: 'primary',
        userId: 'backup-admin',
        params: {},
      }),
    );
    expect(JSON.stringify(port.enqueue.mock.calls)).not.toContain(
      'DATABASE_URL',
    );
  });

  it('rejects a restore with a mismatched target before enqueue', async () => {
    const { service, port } = await fixture();
    await expect(
      service.restore(principal, { filename, target: 'competitor' }),
    ).rejects.toMatchObject({ status: 400 });
    expect(port.enqueue).not.toHaveBeenCalled();
  });

  it('accepts only an existing custom dump for restore', async () => {
    const { service, port, directory } = await fixture();
    await expect(
      service.restore(principal, { filename }),
    ).rejects.toMatchObject({
      status: 404,
    });
    await writeFile(join(directory, filename), 'not-a-dump');
    await expect(
      service.restore(principal, { filename }),
    ).rejects.toMatchObject({
      status: 404,
    });
    await writeFile(join(directory, filename), 'PGDMPfixture');
    await expect(
      service.restore(principal, { filename }),
    ).resolves.toMatchObject({
      status: 'pending',
    });
    expect(port.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'restore', target: 'primary' }),
    );
  });

  it('rechecks current permission and does not enqueue after revocation', async () => {
    const { service, unit, port } = await fixture();
    unit.operatorPermissionCodes.mockResolvedValueOnce([]);
    await expect(service.create(principal, {})).rejects.toMatchObject({
      status: 403,
    });
    expect(port.enqueue).not.toHaveBeenCalled();
  });
});
