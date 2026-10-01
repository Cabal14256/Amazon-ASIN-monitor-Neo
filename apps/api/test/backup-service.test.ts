import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BackupService } from '../src/backup/backup.service';

const principal = { userId: 'backup-admin', sessionId: 'session-1' } as never;
const createdAt = '2026-09-27T00:00:00.000Z';
const filename = 'backup_20260927-020000-abcdef01-primary.dump';
const directories: string[] = [];
const archiveSha256 = createHash('sha256').update('PGDMPfixture').digest('hex');
const databaseSettings = {
  encoding: 'UTF8',
  lcCollate: 'C.UTF-8',
  lcCtype: 'C.UTF-8',
  localeProvider: 'libc',
};

async function writeMetadata(
  directory: string,
  sourceEngine: 'postgresql' | 'timescaledb',
  version: 1 | 2 | 3 | 4 = sourceEngine === 'postgresql' ? 3 : 1,
  scope: 'full' | 'selective' = 'full',
) {
  await writeFile(
    join(directory, `${filename}.meta.json`),
    JSON.stringify({
      version,
      filename,
      target: 'primary',
      sourceEngine,
      ...(version === 3 && sourceEngine === 'postgresql'
        ? {
            scope,
            archiveSha256,
            databaseSettings,
            ...(scope === 'selective' ? { tables: ['public.asins'] } : {}),
          }
        : {}),
      ...((version === 2 || version === 4) && sourceEngine === 'timescaledb'
        ? {
            timescale: {
              extensionVersion: '2.29.2',
              hypertables: ['public.monitor_history'],
              continuousAggregates: ['public.monitor_hourly'],
            },
            databaseSettings,
            ...(version === 4 ? { archiveSha256 } : {}),
          }
        : {}),
    }),
  );
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(maxBytes = 1024 * 1024) {
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
  const scheduledStore = {
    listUser: vi.fn(async () => [] as Record<string, unknown>[]),
  };
  const tasks = {
    openBackup: vi.fn(() => port),
    open: vi.fn(() => ({ store: scheduledStore })),
  };
  const pools = {
    primaryPool: {
      query: vi.fn(async (query: { text: string }) => ({
        rows: query.text.includes('pg_database')
          ? ([{ ...databaseSettings, localeProvider: 'c' }] as Record<
              string,
              unknown
            >[])
          : ([] as Record<string, unknown>[]),
      })),
    },
    competitorPool: {
      query: vi.fn(async () => ({ rows: [] as Record<string, unknown>[] })),
    },
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const service = new BackupService(
    {
      AUTH_DATA_AUTHORITY: 'postgresql',
      BACKUP_STORAGE_DIRECTORY: directory,
      BACKUP_MAX_BYTES: maxBytes,
    } as never,
    repository as never,
    tasks as never,
    pools as never,
    logger as never,
  );
  return {
    directory,
    unit,
    port,
    tasks,
    scheduledStore,
    pools,
    logger,
    service,
  };
}

describe('backup API service', () => {
  it('returns 404 only for a missing dump and logs a partial deletion failure as 500', async () => {
    const { service, directory, logger } = await fixture();
    await expect(service.remove(principal, filename)).rejects.toMatchObject({
      status: 404,
    });
    expect(logger.error).not.toHaveBeenCalled();

    const path = join(directory, filename);
    await writeFile(path, 'PGDMPfixture');
    await mkdir(`${path}.meta.json`);
    await expect(service.remove(principal, filename)).rejects.toMatchObject({
      status: 500,
    });
    expect(logger.error).toHaveBeenCalledWith(
      '备份操作失败',
      'BackupService',
      expect.objectContaining({
        operation: 'delete',
        code: expect.stringMatching(/^E[A-Z0-9_]+$/),
      }),
    );
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(directory);
    expect(logger.info).not.toHaveBeenCalled();
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

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
    ).rejects.toMatchObject({
      status: 409,
    });
    await writeMetadata(directory, 'postgresql');
    await expect(
      service.restore(principal, { filename }),
    ).resolves.toMatchObject({
      status: 'pending',
      restoreMode: 'isolated',
    });
    expect(port.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'restore', target: 'primary' }),
    );
  });

  it('does not offer or enqueue restoration above the current size limit', async () => {
    const { service, port, directory } = await fixture(8);
    await writeFile(join(directory, filename), 'PGDMPfixture');
    await writeMetadata(directory, 'postgresql');
    await expect(service.list(principal)).resolves.toMatchObject([
      { filename, restoreSupported: false },
    ]);
    await expect(
      service.restore(principal, { filename }),
    ).rejects.toMatchObject({ status: 413 });
    expect(port.enqueue).not.toHaveBeenCalled();
  });

  it('keeps selective plain restores in place and rejects older unscoped plain archives', async () => {
    const { service, port, directory } = await fixture();
    await writeFile(join(directory, filename), 'PGDMPfixture');
    await writeMetadata(directory, 'postgresql', 2);
    await expect(service.list(principal)).resolves.toMatchObject([
      { filename, restoreSupported: false },
    ]);
    await expect(
      service.restore(principal, { filename }),
    ).rejects.toMatchObject({ status: 409 });
    await writeMetadata(directory, 'postgresql', 3, 'selective');
    await expect(service.list(principal)).resolves.toMatchObject([
      {
        filename,
        scope: 'selective',
        restoreSupported: true,
        restoreMode: 'in-place',
      },
    ]);
    await expect(
      service.restore(principal, { filename }),
    ).resolves.toMatchObject({ restoreMode: 'in-place' });
    expect(port.enqueue).toHaveBeenCalledTimes(1);
  });

  it.each([
    { encoding: 'LATIN1' },
    { lcCollate: 'C' },
    { lcCtype: 'C' },
    { localeProvider: 'i', icuLocale: 'en-US' },
  ])(
    'does not offer or enqueue selective restore when current locale differs: %j',
    async (difference) => {
      const { service, port, directory, pools } = await fixture();
      await writeFile(join(directory, filename), 'PGDMPfixture');
      await writeMetadata(directory, 'postgresql', 3, 'selective');
      pools.primaryPool.query.mockImplementation(async (query) => ({
        rows: query.text.includes('pg_database')
          ? [{ ...databaseSettings, localeProvider: 'c', ...difference }]
          : [],
      }));
      const files = await service.list(principal);
      expect(files).toMatchObject([{ filename, restoreSupported: false }]);
      expect(files[0]).not.toHaveProperty('databaseSettings');
      await expect(
        service.restore(principal, { filename }),
      ).rejects.toMatchObject({ status: 409 });
      expect(port.enqueue).not.toHaveBeenCalled();
      // A full archive creates its own source-locale database, so this mismatch
      // must not prevent isolated recovery.
      await writeMetadata(directory, 'postgresql', 3, 'full');
      await expect(service.list(principal)).resolves.toMatchObject([
        { restoreSupported: true },
      ]);
      await expect(
        service.restore(principal, { filename }),
      ).resolves.toMatchObject({ restoreMode: 'isolated' });
    },
  );

  it('fails closed when the selective locale probe is unavailable or ICU rules differ', async () => {
    const { service, port, directory, pools } = await fixture();
    await writeFile(join(directory, filename), 'PGDMPfixture');
    await writeMetadata(directory, 'postgresql', 3, 'selective');
    const metadataPath = join(directory, `${filename}.meta.json`);
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    const icu = {
      ...databaseSettings,
      localeProvider: 'icu',
      icuLocale: 'en-US',
      icuRules: '&a<b',
    };
    await writeFile(
      metadataPath,
      JSON.stringify({ ...metadata, databaseSettings: icu }),
    );
    pools.primaryPool.query.mockImplementation(async (query) => ({
      rows: query.text.includes('pg_database')
        ? [{ ...icu, localeProvider: 'i', icuRules: '&a<c' }]
        : [],
    }));
    await expect(service.list(principal)).resolves.toMatchObject([
      { restoreSupported: false },
    ]);
    await expect(
      service.restore(principal, { filename }),
    ).rejects.toMatchObject({ status: 409 });
    pools.primaryPool.query.mockImplementation(async (query) => {
      if (query.text.includes('pg_database'))
        throw new Error('catalog unavailable');
      return { rows: [] };
    });
    await expect(service.list(principal)).resolves.toMatchObject([
      { restoreSupported: false },
    ]);
    await expect(
      service.restore(principal, { filename }),
    ).rejects.toMatchObject({ status: 500 });
    expect(port.enqueue).not.toHaveBeenCalled();
  });

  it('does not offer a plain restore when its v3 sidecar lacks an archive digest or source database settings', async () => {
    const { service, port, directory } = await fixture();
    await writeFile(join(directory, filename), 'PGDMPfixture');
    await writeMetadata(directory, 'postgresql', 3, 'selective');
    const path = join(directory, `${filename}.meta.json`);
    const valid = JSON.parse(await readFile(path, 'utf8')) as Record<
      string,
      unknown
    >;
    for (const field of ['archiveSha256', 'databaseSettings']) {
      const invalid = { ...valid };
      delete invalid[field];
      await writeFile(path, JSON.stringify(invalid));
      await expect(service.list(principal)).resolves.toMatchObject([
        { filename, restoreSupported: false },
      ]);
      await expect(
        service.restore(principal, { filename }),
      ).rejects.toMatchObject({ status: 409 });
    }
    expect(port.enqueue).not.toHaveBeenCalled();
  });

  it('downloads only an artifact accompanied by verified restore metadata', async () => {
    const { service, directory } = await fixture();
    await writeFile(join(directory, filename), 'PGDMPfixture');
    await expect(service.download(principal, filename)).rejects.toMatchObject({
      status: 409,
    });
    await writeMetadata(directory, 'postgresql', 2);
    await expect(service.download(principal, filename)).resolves.toMatchObject({
      filename,
      metadata: { version: 2, sourceEngine: 'postgresql' },
    });
  });

  it('bounds both database capability probes and exposes scheduled runs only to administrators', async () => {
    const { service, directory, unit, pools, tasks, scheduledStore } =
      await fixture();
    await writeFile(join(directory, filename), 'PGDMPfixture');
    await writeMetadata(directory, 'postgresql', 2);
    await service.list(principal);
    for (const pool of [pools.primaryPool, pools.competitorPool])
      expect(pool.query).toHaveBeenCalledWith(
        expect.objectContaining({ query_timeout: 1500 }),
      );
    scheduledStore.listUser.mockResolvedValueOnce([
      {
        taskId: 'scheduled-1',
        userId: 'system:backup-scheduler',
        taskType: 'backup',
        taskSubType: 'create',
        title: '自动备份（primary）',
        status: 'failed',
        progress: 33,
        message: '备份任务失败',
        error: '备份任务失败',
        result: null,
        createdAt,
        updatedAt: createdAt,
        startedAt: createdAt,
        completedAt: createdAt,
        cancelRequestedAt: null,
        cancelledAt: null,
        revision: 3,
      },
    ]);
    await expect(service.scheduledTasks(principal)).resolves.toMatchObject([
      { taskId: 'scheduled-1', status: 'failed' },
    ]);
    expect(scheduledStore.listUser).toHaveBeenCalledWith(
      'system:backup-scheduler',
      { limit: 50 },
    );
    unit.operatorPermissionCodes.mockResolvedValueOnce([]);
    await expect(service.scheduledTasks(principal)).rejects.toMatchObject({
      status: 403,
    });
    expect(tasks.open).toHaveBeenCalledTimes(1);
  });

  it('rechecks current permission and does not enqueue after revocation', async () => {
    const { service, unit, port } = await fixture();
    unit.operatorPermissionCodes.mockResolvedValueOnce([]);
    await expect(service.create(principal, {})).rejects.toMatchObject({
      status: 403,
    });
    expect(port.enqueue).not.toHaveBeenCalled();
  });

  it('keeps legacy Timescale artifacts unrestorable and rejects selective dumps', async () => {
    const { service, port, directory, pools } = await fixture();
    pools.primaryPool.query.mockResolvedValue({
      rows: [{ extversion: '2.29.2' }],
    });
    await writeFile(join(directory, filename), 'PGDMPfixture');
    await writeMetadata(directory, 'timescaledb');
    await expect(service.list(principal)).resolves.toMatchObject([
      { filename, sourceEngine: 'timescaledb', restoreSupported: false },
    ]);
    await expect(
      service.restore(principal, { filename }),
    ).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      service.create(principal, { tables: ['public.monitor_history'] }),
    ).rejects.toMatchObject({ status: 409 });
    expect(port.enqueue).not.toHaveBeenCalled();
  });

  it('accepts a verified Timescale dump for isolated recovery without promising a live cutover', async () => {
    const { service, port, directory, pools } = await fixture();
    pools.primaryPool.query.mockResolvedValue({
      rows: [{ extversion: '2.29.2' }],
    });
    await writeFile(join(directory, filename), 'PGDMPfixture');
    await writeMetadata(directory, 'timescaledb', 2);
    await expect(service.list(principal)).resolves.toMatchObject([
      { filename, restoreSupported: false },
    ]);
    await expect(
      service.restore(principal, { filename }),
    ).rejects.toMatchObject({ status: 409 });
    expect(port.enqueue).not.toHaveBeenCalled();
    await writeMetadata(directory, 'timescaledb', 4);
    await expect(service.list(principal)).resolves.toMatchObject([
      { filename, restoreSupported: true, restoreMode: 'isolated' },
    ]);
    await expect(
      service.restore(principal, { filename }),
    ).resolves.toMatchObject({
      status: 'pending',
      restoreMode: 'isolated',
    });
    expect(port.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'restore', target: 'primary' }),
    );
  });

  it('does not offer isolated Timescale recovery from an older sidecar without source locale', async () => {
    const { service, port, directory, pools } = await fixture();
    pools.primaryPool.query.mockResolvedValue({
      rows: [{ extversion: '2.29.2' }],
    });
    await writeFile(join(directory, filename), 'PGDMPfixture');
    await writeMetadata(directory, 'timescaledb', 2);
    const path = join(directory, `${filename}.meta.json`);
    const invalid = JSON.parse(await readFile(path, 'utf8')) as Record<
      string,
      unknown
    >;
    delete invalid.databaseSettings;
    await writeFile(path, JSON.stringify(invalid));
    await expect(service.list(principal)).resolves.toMatchObject([
      { filename, restoreSupported: false },
    ]);
    await expect(
      service.restore(principal, { filename }),
    ).rejects.toMatchObject({ status: 409 });
    expect(port.enqueue).not.toHaveBeenCalled();
  });

  it('fails closed when the Timescale extension version differs from the archive', async () => {
    const { service, port, directory, pools } = await fixture();
    pools.primaryPool.query.mockResolvedValue({
      rows: [{ extversion: '2.28.0' }],
    });
    await writeFile(join(directory, filename), 'PGDMPfixture');
    await writeMetadata(directory, 'timescaledb', 4);
    await expect(service.list(principal)).resolves.toMatchObject([
      { filename, restoreSupported: false },
    ]);
    await expect(
      service.restore(principal, { filename }),
    ).rejects.toMatchObject({
      status: 409,
    });
    expect(port.enqueue).not.toHaveBeenCalled();
  });

  it('rejects a Timescale artifact even when the target is plain PostgreSQL', async () => {
    const { service, port, directory } = await fixture();
    await writeFile(join(directory, filename), 'PGDMPfixture');
    await writeMetadata(directory, 'timescaledb');
    await expect(service.list(principal)).resolves.toMatchObject([
      { filename, restoreSupported: false },
    ]);
    await expect(
      service.restore(principal, { filename }),
    ).rejects.toMatchObject({
      status: 409,
    });
    expect(port.enqueue).not.toHaveBeenCalled();
  });
});
