import { BACKUP_SCHEDULER_USER_ID } from '@asin-monitor/contracts';
import { transitionTask, type TaskState } from '@asin-monitor/db';
import { HttpException, type ExecutionContext } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuditInterceptor } from '../src/audit/audit.interceptor';
import { AuditService } from '../src/audit/audit.service';
import { AuthenticationGuard } from '../src/auth/authentication.guard';
import { PermissionsGuard } from '../src/auth/permissions.guard';
import { readBackupMetadata } from '../src/backup/backup-files';
import { BackupController } from '../src/backup/backup.controller';
import { BackupService } from '../src/backup/backup.service';
import { configureHttpApp } from '../src/http-app';
import type { QueueTaskSnapshot } from '../src/tasks/task-query-values';
import { backupCreationFixture } from './helpers/backup-creation-fixtures';
import { taskFixture } from './helpers/task-query-fixtures';

const sidecarFailure = vi.hoisted(() => ({
  stat: null as Error | null,
  read: null as Error | null,
  remove: null as Error | null,
}));
const archiveFailure = vi.hoisted(() => ({
  phase: null as 'stat' | 'open' | 'read' | null,
  error: null as Error | null,
}));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  return {
    ...fs,
    lstat: async (...args: unknown[]) => {
      if (archiveFailure.phase === 'stat' && String(args[0]).endsWith('.dump'))
        throw archiveFailure.error;
      if (sidecarFailure.stat && String(args[0]).endsWith('.meta.json'))
        throw sidecarFailure.stat;
      return Reflect.apply(fs.lstat, fs, args);
    },
    readFile: async (...args: unknown[]) => {
      if (sidecarFailure.read && String(args[0]).endsWith('.meta.json'))
        throw sidecarFailure.read;
      return Reflect.apply(fs.readFile, fs, args);
    },
    unlink: async (...args: unknown[]) => {
      if (sidecarFailure.remove && String(args[0]).endsWith('.meta.json'))
        throw sidecarFailure.remove;
      return Reflect.apply(fs.unlink, fs, args);
    },
    open: async (...args: unknown[]) => {
      if (String(args[0]).endsWith('.dump')) {
        if (archiveFailure.phase === 'open') throw archiveFailure.error;
        const handle = await Reflect.apply(fs.open, fs, args);
        if (archiveFailure.phase === 'read')
          return {
            read: async () => {
              throw archiveFailure.error;
            },
            close: () => handle.close(),
          };
        return handle;
      }
      return Reflect.apply(fs.open, fs, args);
    },
  };
});

const principal = {
  userId: 'backup-admin',
  sessionId: 'session-1',
  user: { username: 'backup-admin-fixture' },
} as never;
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
  archiveFailure.phase = null;
  archiveFailure.error = null;
  sidecarFailure.stat = null;
  sidecarFailure.read = null;
  sidecarFailure.remove = null;
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
    upsert: vi.fn(async (input: Record<string, unknown>) => ({
      id: 1,
      enabled: input.enabled === true || input.enabled === 1,
      scheduleType: input.scheduleType ?? 'daily',
      scheduleValue: input.scheduleValue ?? null,
      backupTime: input.backupTime ?? '02:00',
      createTime: null,
      updateTime: null,
    })),
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
    mutate: vi.fn(async () => null as TaskState | null),
  };
  const scheduledPort = {
    store: scheduledStore,
    findJob: vi.fn(async () => null as QueueTaskSnapshot | null),
  };
  const tasks = {
    openBackup: vi.fn(() => port),
    open: vi.fn(() => scheduledPort),
  };
  const pools = {
    primaryPool: {
      query: vi.fn(async (query: { text: string }) => ({
        rows: query.text.includes('backup_selective_restore_dependencies')
          ? [{ blocked: false }]
          : query.text.includes('pg_database')
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
  const env = {
    AUTH_DATA_AUTHORITY: 'postgresql',
    BACKUP_STORAGE_DIRECTORY: directory,
    BACKUP_MAX_BYTES: maxBytes,
    TASK_META_TTL_SECONDS: 604800,
  };
  const service = new BackupService(
    env as never,
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
    scheduledPort,
    pools,
    logger,
    service,
    env,
  };
}

describe('backup submission HTTP / global exception boundary', () => {
  it.each([
    { ttl: 1, enabled: true },
    { ttl: 604799, enabled: true },
    { ttl: 1, enabled: 1 },
    { ttl: 604800, enabled: true },
    { ttl: 604800, enabled: 1 },
  ])(
    'enables an automatic backup only with a runnable retention window (%j)',
    async ({ ttl, enabled }) => {
      const f = await fixture();
      f.env.TASK_META_TTL_SECONDS = ttl;
      const app = await http(f.service);
      try {
        const input = {
          enabled,
          scheduleType: 'daily',
          backupTime: '02:00',
        };
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/backup/config',
          payload: input,
        });
        expect(response.statusCode).toBe(ttl < 604800 ? 503 : 200);
        if (ttl < 604800) {
          expect(f.unit.upsert).not.toHaveBeenCalled();
          expect(f.logger.warn).toHaveBeenCalledWith(
            '备份任务元数据保留配置不满足执行窗口',
            'BackupService',
            { reason: 'backup_task_retention_too_short' },
          );
        } else {
          expect(f.unit.upsert).toHaveBeenCalledOnce();
          expect(response.json().success).toBe(true);
        }
      } finally {
        await app.close();
      }
    },
  );
  it('allows disabling an automatic backup under short retention after authorization', async () => {
    const f = await fixture();
    f.env.TASK_META_TTL_SECONDS = 1;
    const app = await http(f.service);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/backup/config',
        payload: { enabled: false, scheduleType: 'daily', backupTime: '02:00' },
      });
      expect(response.statusCode).toBe(200);
      expect(f.unit.upsert).toHaveBeenCalledOnce();
      expect(f.unit.lockOperator).toHaveBeenCalled();
      expect(f.logger.warn).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('rechecks permission before exposing schedule retention or writing configuration', async () => {
    const f = await fixture();
    f.env.TASK_META_TTL_SECONDS = 1;
    f.unit.operatorPermissionCodes.mockResolvedValue([]);
    const app = await http(f.service);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/backup/config',
        payload: { enabled: true },
      });
      expect(response.statusCode).toBe(403);
      expect(f.unit.upsert).not.toHaveBeenCalled();
      expect(f.logger.warn).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  it('freezes the actual application-session schema for an unqualified selective table before enqueue', async () => {
    const f = await fixture();
    f.pools.primaryPool.query.mockImplementation(async (query) => ({
      rows: query.text.includes('backup_table_selection')
        ? [
            {
              schema: 'tenant.audit',
              name: 'orders',
              kind: 'r',
              persistence: 'p',
            },
          ]
        : [],
    }));
    await f.service.create(principal, { tables: ['orders'] });
    expect(f.port.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { tables: ['"tenant.audit"."orders"'] },
      }),
    );
    expect(f.pools.primaryPool.query).toHaveBeenCalledWith(
      expect.objectContaining({ query_timeout: 1500, values: [['"orders"']] }),
    );
  });
  it('refuses an unresolved or name-truncated selective table before creating task metadata', async () => {
    const f = await fixture();
    f.pools.primaryPool.query.mockImplementation(async (query) => ({
      rows: query.text.includes('backup_table_selection')
        ? [{ schema: 'public', name: 'different', kind: 'r', persistence: 'p' }]
        : [],
    }));
    await expect(
      f.service.create(principal, { tables: ['requested'] }),
    ).rejects.toMatchObject({ status: 400 });
    expect(f.port.store.create).not.toHaveBeenCalled();
    expect(f.port.enqueue).not.toHaveBeenCalled();
  });
  it('uses the same exact quoted schema and table from new sidecars during restore preflight', async () => {
    const f = await fixture();
    await writeFile(join(f.directory, filename), 'PGDMPfixture');
    await writeMetadata(f.directory, 'postgresql', 3, 'selective');
    const path = join(f.directory, `${filename}.meta.json`);
    const metadata = JSON.parse(await readFile(path, 'utf8'));
    metadata.tables = ['"tenant.audit""quoted"."orders"'];
    await writeFile(path, JSON.stringify(metadata));
    await f.service.restore(principal, { filename });
    expect(f.pools.primaryPool.query).toHaveBeenCalledWith(
      expect.objectContaining({
        values: [['orders'], ['tenant.audit"quoted']],
        query_timeout: 1500,
      }),
    );
    expect(f.port.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'restore', params: { filename } }),
    );
  });
  it('rejects selective restore before task creation when an unselected relation depends on the selection', async () => {
    const f = await fixture();
    await writeFile(join(f.directory, filename), 'PGDMPfixture');
    await writeMetadata(f.directory, 'postgresql', 3, 'selective');
    const query = f.pools.primaryPool.query.getMockImplementation()!;
    f.pools.primaryPool.query.mockImplementation(async (config) =>
      config.text.includes('backup_selective_restore_dependencies')
        ? { rows: [{ blocked: true }] }
        : query(config),
    );
    await expect(
      f.service.restore(principal, { filename }),
    ).rejects.toMatchObject({
      status: 409,
      response: { errorMessage: expect.stringContaining('未包含') },
    });
    expect(f.tasks.openBackup).not.toHaveBeenCalled();
    expect(f.port.enqueue).not.toHaveBeenCalled();
    expect(f.logger.error).not.toHaveBeenCalled();
    const app = await http(f.service);
    try {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/backup/restore',
        payload: { filename },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        success: false,
        errorCode: 409,
        errorMessage: expect.stringContaining('未包含'),
      });
      expect(f.tasks.openBackup).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
  async function http(service: BackupService, audit?: AuditService) {
    const module = await Test.createTestingModule({
      controllers: [BackupController],
      providers: [
        { provide: BackupService, useValue: service },
        ...(audit
          ? [{ provide: APP_INTERCEPTOR, useClass: AuditInterceptor }]
          : []),
      ],
    })
      .overrideGuard(AuthenticationGuard)
      .useValue({
        canActivate(context: ExecutionContext) {
          context.switchToHttp().getRequest().auth = principal;
          return true;
        },
      })
      .overrideGuard(PermissionsGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const app = module.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter({ logger: false }),
    );
    configureHttpApp(app, {
      logger: { error: vi.fn(), warn: vi.fn() } as never,
      ...(audit ? { audit } : {}),
    });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    return app;
  }
  it.each([
    { payload: {}, target: 'primary', status: 200 },
    {
      payload: { description: 'private-person' },
      target: 'primary',
      status: 200,
    },
    { payload: { target: 'competitor' }, target: 'competitor', status: 200 },
    { payload: { target: null }, target: null, status: 400 },
    { payload: { target: 'invalid' }, target: null, status: 400 },
    { payload: [], target: null, status: 400 },
    { payload: null, target: null, status: 400 },
  ])(
    'audits the effective create target through the actual controller ($payload)',
    async ({ payload, target, status }) => {
      const f = await fixture();
      const repository = { append: vi.fn(async () => undefined) };
      const audit = new AuditService(repository, f.logger as never);
      const app = await http(f.service, audit);
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/backup',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify(payload),
        });
        expect(response.statusCode).toBe(status);
        await audit.flush();
        expect(repository.append).toHaveBeenCalledOnce();
        expect(repository.append).toHaveBeenCalledWith(
          expect.objectContaining({
            action: 'CREATE',
            resource: 'backup',
            resourceName: target,
            requestData:
              payload === null || Array.isArray(payload) ? null : { target },
            responseStatus: status,
          }),
        );
        if (status === 200) {
          expect(f.port.enqueue).toHaveBeenCalledOnce();
          expect(f.port.enqueue).toHaveBeenCalledWith(
            expect.objectContaining({ operation: 'create', target }),
          );
        } else {
          expect(f.port.enqueue).not.toHaveBeenCalled();
          expect(f.port.store.create).not.toHaveBeenCalled();
        }
        expect(JSON.stringify(repository.append.mock.calls)).not.toContain(
          'private-person',
        );
      } finally {
        await audit.flush();
        await app.close();
      }
    },
  );
  it('returns the original execution window in list/download HTTP and accepts the timed archive for restore', async () => {
    const f = await fixture();
    await writeFile(join(f.directory, filename), 'PGDMPfixture');
    await writeMetadata(f.directory, 'postgresql');
    const execution = {
      timeSource: 'dump-start',
      dumpStartedAt: '2026-09-30T01:00:00.123Z',
      dumpCompletedAt: '2026-09-30T01:02:00.456Z',
      publicationStartedAt: '2026-09-30T01:03:00.789Z',
    };
    const metadataPath = join(f.directory, `${filename}.meta.json`);
    const oldMetadata = JSON.parse(await readFile(metadataPath, 'utf8'));
    await writeFile(
      metadataPath,
      JSON.stringify({ ...oldMetadata, execution }),
    );
    const app = await http(f.service);
    try {
      const list = await app.inject({ method: 'GET', url: '/api/v1/backup' });
      expect(list.statusCode).toBe(200);
      expect(list.json().data).toMatchObject([
        {
          filename,
          createdAt: execution.dumpStartedAt,
          timeSource: 'dump-start',
          execution,
        },
      ]);
      const download = await app.inject({
        method: 'GET',
        url: `/api/v1/backup/${filename}/download`,
      });
      expect(download.statusCode).toBe(200);
      expect(download.headers['content-type']).toContain('application/x-tar');
      // One small dump occupies one padded tar data block. Read the second
      // entry's advertised size rather than relying on JSON substring matching.
      const metadataBytes = Number.parseInt(
        download.rawPayload
          .subarray(1148, 1160)
          .toString('ascii')
          .replaceAll('\0', '')
          .trim(),
        8,
      );
      expect(
        JSON.parse(
          download.rawPayload
            .subarray(1536, 1536 + metadataBytes)
            .toString('utf8'),
        ),
      ).toEqual({ ...oldMetadata, execution });
      const restore = await app.inject({
        method: 'POST',
        url: '/api/v1/backup/restore',
        payload: { filename },
      });
      expect(restore.statusCode).toBe(200);
      expect(restore.json().data.restoreMode).toBe('isolated');
    } finally {
      await app.close();
    }
  });
  it.each(['download', 'delete'] as const)(
    'rejects malformed %s filenames with bounded HTTP 400 and warn logs',
    async (operation) => {
      const f = await fixture();
      const app = await http(f.service);
      try {
        for (const invalid of [
          'typo.dump',
          `${filename}.partial`,
          '../private-client-token',
          `${filename} `,
          'legacy.sql',
        ]) {
          const response = await app.inject({
            method: operation === 'download' ? 'GET' : 'DELETE',
            url: `/api/v1/backup/${encodeURIComponent(invalid)}${
              operation === 'download' ? '/download' : ''
            }`,
          });
          expect(response.statusCode).toBe(400);
          expect(response.json()).toMatchObject({
            success: false,
            errorCode: 400,
            errorMessage: '备份文件名无效',
          });
          expect(f.logger.warn).toHaveBeenLastCalledWith(
            '备份文件名无效',
            'BackupService',
            { operation, reason: 'backup_filename_invalid' },
          );
          expect(f.logger.error).not.toHaveBeenCalled();
          expect(JSON.stringify(f.logger.warn.mock.calls)).not.toContain(
            invalid,
          );
          expect(response.body).not.toContain('private-client-token');
        }
        const missing = await app.inject({
          method: operation === 'download' ? 'GET' : 'DELETE',
          url: `/api/v1/backup/${filename}${
            operation === 'download' ? '/download' : ''
          }`,
        });
        expect(missing.statusCode).toBe(404);
        expect(f.logger.error).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
  it.each(['create', 'restore'] as const)(
    'rejects short retention with HTTP 503 before %s creates metadata or enqueues',
    async (operation) => {
      const f = await fixture();
      f.env.TASK_META_TTL_SECONDS = 1;
      if (operation === 'restore') {
        await writeFile(join(f.directory, filename), 'PGDMPfixture');
        await writeMetadata(f.directory, 'postgresql');
      }
      const app = await http(f.service);
      try {
        const response = await app.inject({
          method: 'POST',
          url:
            operation === 'create'
              ? '/api/v1/backup'
              : '/api/v1/backup/restore',
          payload: operation === 'create' ? {} : { filename },
        });
        expect(response.statusCode).toBe(503);
        expect(response.json()).toMatchObject({
          success: false,
          errorCode: 503,
          errorMessage: '服务器内部错误',
        });
        expect(f.logger.warn).toHaveBeenCalledWith(
          '备份任务元数据保留配置不满足执行窗口',
          'BackupService',
          { reason: 'backup_task_retention_too_short' },
        );
        expect(f.tasks.openBackup).not.toHaveBeenCalled();
        expect(f.port.store.create).not.toHaveBeenCalled();
        expect(f.port.enqueue).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    },
  );
  it.each(['list', 'restore', 'download'] as const)(
    'reports native archive I/O failures in actual %s HTTP responses',
    async (operation) => {
      const f = await fixture();
      await writeFile(join(f.directory, filename), 'PGDMPfixture');
      await writeMetadata(f.directory, 'postgresql');
      const app = await http(f.service);
      try {
        for (const [phase, code] of [
          ['stat', 'EACCES'],
          ['open', 'EIO'],
          ['read', 'ESTALE'],
        ] as const) {
          archiveFailure.phase = phase;
          archiveFailure.error = Object.assign(
            new Error(`private-token ${f.directory}`),
            { code },
          );
          const response = await app.inject({
            method: operation === 'restore' ? 'POST' : 'GET',
            url:
              operation === 'list'
                ? '/api/v1/backup'
                : operation === 'restore'
                ? '/api/v1/backup/restore'
                : `/api/v1/backup/${filename}/download`,
            ...(operation === 'restore' ? { payload: { filename } } : {}),
          });
          expect(response.statusCode).toBe(500);
          expect(f.logger.error).toHaveBeenLastCalledWith(
            '备份操作失败',
            'BackupService',
            { operation, reason: 'backup_operation_failed', code },
          );
          expect(
            response.body + JSON.stringify(f.logger.error.mock.calls),
          ).not.toContain('private-token');
          expect(
            response.body + JSON.stringify(f.logger.error.mock.calls),
          ).not.toContain(f.directory);
          expect(f.port.enqueue).not.toHaveBeenCalled();
        }
      } finally {
        archiveFailure.phase = null;
        await app.close();
      }
    },
  );
  it('reports EISDIR from partial sidecar deletion as a fixed server failure', async () => {
    const f = await fixture();
    const path = join(f.directory, filename);
    await writeFile(path, 'PGDMPfixture');
    await writeMetadata(f.directory, 'postgresql');
    const app = await http(f.service);
    sidecarFailure.remove = Object.assign(
      new Error(`private-delete-token ${f.directory}`),
      { code: 'EISDIR' },
    );
    try {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/v1/backup/${filename}`,
      });
      expect(response.statusCode).toBe(500);
      expect(f.logger.error).toHaveBeenLastCalledWith(
        '备份操作失败',
        'BackupService',
        {
          operation: 'delete',
          reason: 'backup_operation_failed',
          code: 'EISDIR',
        },
      );
      expect(
        response.body + JSON.stringify(f.logger.error.mock.calls),
      ).not.toContain('private-delete-token');
      expect(
        response.body + JSON.stringify(f.logger.error.mock.calls),
      ).not.toContain(f.directory);
      await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(`${path}.meta.json`, 'utf8')).toContain(filename);
    } finally {
      sidecarFailure.remove = null;
      await app.close();
    }
  });
  it.each(['create', 'enqueue'] as const)(
    'retains the generated UUID after an uncertain %s acknowledgement',
    async (phase) => {
      const f = await fixture();
      const failure = new Error('private-driver-token');
      if (phase === 'create')
        f.port.store.create.mockRejectedValueOnce(failure);
      else f.port.enqueue.mockRejectedValueOnce(failure);
      const app = await http(f.service);
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/api/v1/backup',
          payload: {},
        });
        const taskId = f.port.store.create.mock.calls[0][0].taskId;
        expect(taskId).toMatch(/^[a-f0-9-]{36}$/);
        expect(response.statusCode).toBe(500);
        expect(response.json()).toEqual({
          success: false,
          errorCode: 500,
          errorMessage: '任务提交结果未确认，请查询此任务状态后再操作',
          data: { taskId, status: 'unknown' },
        });
        expect(response.headers['cache-control']).toBe('no-store');
        expect(
          response.body + JSON.stringify(f.logger.error.mock.calls),
        ).not.toContain('private-driver');
      } finally {
        await app.close();
      }
    },
  );
  it('preserves restore lookup identity and masks unrelated 5xx payloads', async () => {
    const f = await fixture();
    await writeFile(join(f.directory, filename), 'PGDMPfixture');
    await writeMetadata(f.directory, 'postgresql');
    f.port.enqueue.mockRejectedValueOnce(new Error('private-driver-token'));
    const app = await http(f.service);
    try {
      const restore = await app.inject({
        method: 'POST',
        url: '/api/v1/backup/restore',
        payload: { filename },
      });
      expect(restore.statusCode).toBe(500);
      expect(restore.json().data.taskId).toBe(
        f.port.store.create.mock.calls[0][0].taskId,
      );
      vi.spyOn(f.service, 'create').mockRejectedValueOnce(
        new HttpException(
          {
            data: { taskId: 'private-driver-token' },
            errorMessage: 'private-driver-token',
          },
          500,
        ),
      );
      const failed = await app.inject({
        method: 'POST',
        url: '/api/v1/backup',
        payload: {},
      });
      expect(failed.json()).toEqual({
        success: false,
        errorCode: 500,
        errorMessage: '服务器内部错误',
      });
    } finally {
      await app.close();
    }
  });
});

describe('scheduled backup queue reconciliation and sidecar storage errors', () => {
  it('keeps delayed dump times in the public scheduled result while removing its unchanged private proof', async () => {
    const f = await fixture();
    const published = backupCreationFixture(
      BACKUP_SCHEDULER_USER_ID,
      createdAt,
    );
    const execution = {
      timeSource: 'dump-start',
      dumpStartedAt: '2026-09-30T01:00:00.123Z',
      dumpCompletedAt: '2026-09-30T01:02:00.456Z',
      publicationStartedAt: '2026-09-30T01:03:00.789Z',
    };
    const result = {
      ...published.result,
      createdAt: execution.dumpStartedAt,
      timeSource: 'dump-start',
      execution,
    };
    let task = taskFixture({ ...published.data, status: 'failed' });
    f.scheduledStore.listUser.mockResolvedValue([task]);
    f.scheduledPort.findJob.mockResolvedValue({
      ...task,
      status: 'completed',
      result,
      backupData: published.data,
    });
    f.scheduledStore.mutate.mockImplementation(async (...args: unknown[]) => {
      task = transitionTask(task, args[1] as never, new Date());
      return task;
    });
    const rows = await f.service.scheduledTasks(principal);
    expect(rows).toMatchObject([
      {
        status: 'completed',
        result: {
          createdAt: execution.dumpStartedAt,
          timeSource: 'dump-start',
          execution,
        },
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain('backupCreationCommit');
    expect(
      (task.result as { backupCreationCommit: unknown }).backupCreationCommit,
    ).toEqual(published.result.backupCreationCommit);
  });
  it.each(['cancelling', 'cancelled', 'failed'] as const)(
    'recovers a scheduled durable creation from %s with shared receipt validation',
    async (status) => {
      const f = await fixture();
      const published = backupCreationFixture(
        BACKUP_SCHEDULER_USER_ID,
        createdAt,
      );
      let task = taskFixture({
        ...published.data,
        status,
        cancelRequestedAt: createdAt,
      });
      f.scheduledStore.listUser.mockImplementation(async () => [task]);
      f.scheduledPort.findJob.mockResolvedValue({
        ...task,
        status: 'completed',
        result: published.result,
        backupData: published.data,
      });
      f.scheduledStore.mutate.mockImplementation(async (...args: unknown[]) => {
        task = transitionTask(task, args[1] as never, new Date());
        return task;
      });
      const result = await f.service.scheduledTasks(principal);
      expect(result).toMatchObject([
        {
          status: 'completed',
          canCancel: false,
          result: { filename: published.result.filename },
        },
      ]);
      expect(JSON.stringify(result)).not.toContain('backupCreationCommit');
      expect(JSON.stringify(result)).not.toContain('params');
    },
  );
  it('retries a scheduled receipt after lost CAS ACK and preserves absence of queue proof', async () => {
    const f = await fixture();
    const published = backupCreationFixture(
      BACKUP_SCHEDULER_USER_ID,
      createdAt,
    );
    let task = taskFixture({ ...published.data, status: 'cancelled' });
    f.scheduledStore.listUser.mockImplementation(async () => [task]);
    expect(await f.service.scheduledTasks(principal)).toMatchObject([
      { status: 'cancelled' },
    ]);
    expect(f.scheduledStore.mutate).not.toHaveBeenCalled();
    f.scheduledPort.findJob.mockResolvedValue({
      ...task,
      status: 'completed',
      result: published.result,
      backupData: published.data,
    });
    f.scheduledStore.mutate
      .mockImplementation(async (...args: unknown[]) => {
        task = transitionTask(task, args[1] as never, new Date());
        return task;
      })
      .mockRejectedValueOnce(new Error('private-cas-token'));
    await expect(f.service.scheduledTasks(principal)).rejects.toMatchObject({
      status: 500,
    });
    expect(task.status).toBe('cancelled');
    expect(await f.service.scheduledTasks(principal)).toMatchObject([
      { status: 'completed' },
    ]);
    expect(JSON.stringify(f.logger.error.mock.calls)).not.toContain(
      'private-cas',
    );
  });
  const scheduled = () =>
    taskFixture({
      taskId: '10000000-0000-4000-8000-000000000161',
      userId: BACKUP_SCHEDULER_USER_ID,
      taskType: 'backup',
      taskSubType: 'create',
      status: 'processing',
      createdAt,
    });
  it.each(['completed', 'failed'] as const)(
    'recovers a scheduled %s run after a lost registry acknowledgement',
    async (status) => {
      const f = await fixture();
      let task = scheduled();
      f.scheduledStore.listUser.mockResolvedValueOnce([task]);
      f.scheduledPort.findJob.mockResolvedValueOnce({
        ...task,
        status,
        result: { filename, format: 'custom', target: 'primary' },
      });
      f.scheduledStore.mutate.mockImplementation(async (...args: unknown[]) => {
        task = transitionTask(task, args[1] as never, new Date());
        return task;
      });
      await expect(f.service.scheduledTasks(principal)).resolves.toMatchObject([
        { taskId: task.taskId, status, canCancel: false, downloadUrl: null },
      ]);
      expect(f.scheduledPort.findJob).toHaveBeenCalledWith(
        task.taskId,
        'backup',
      );
      expect(f.scheduledStore.mutate).toHaveBeenCalledWith(
        task.taskId,
        expect.objectContaining({ kind: status }),
        {
          userId: BACKUP_SCHEDULER_USER_ID,
          taskType: 'backup',
          taskSubType: 'create',
          createdAt,
        },
      );
    },
  );
  it.each([
    ['taskId', 'another-task'],
    ['userId', 'another-owner'],
    ['taskType', 'export'],
    ['taskSubType', 'restore'],
    ['createdAt', '2026-09-28T00:00:00.000Z'],
  ])(
    'rejects a replaced queue %s before registry mutation',
    async (key, value) => {
      const f = await fixture();
      const task = scheduled();
      f.scheduledStore.listUser.mockResolvedValueOnce([task]);
      f.scheduledPort.findJob.mockResolvedValueOnce({
        ...task,
        status: 'completed',
        [key]: value,
      });
      await expect(f.service.scheduledTasks(principal)).rejects.toMatchObject({
        status: 500,
      });
      expect(f.scheduledStore.mutate).not.toHaveBeenCalled();
      expect(JSON.stringify(f.logger.error.mock.calls)).not.toContain(value);
    },
  );
  it('rejects an identity replacement during the registry CAS', async () => {
    const f = await fixture();
    const task = scheduled();
    f.scheduledStore.listUser.mockResolvedValueOnce([task]);
    f.scheduledPort.findJob.mockResolvedValueOnce({
      ...task,
      status: 'completed',
    });
    f.scheduledStore.mutate.mockResolvedValueOnce({
      ...task,
      userId: 'another-owner',
    });
    await expect(f.service.scheduledTasks(principal)).rejects.toMatchObject({
      status: 500,
    });
  });
  it.each([null, 'processing'] as const)(
    'keeps a nonterminal record when queue state is %s',
    async (status) => {
      const f = await fixture();
      const task = scheduled();
      f.scheduledStore.listUser.mockResolvedValueOnce([task]);
      if (status)
        f.scheduledPort.findJob.mockResolvedValueOnce({ ...task, status });
      await expect(f.service.scheduledTasks(principal)).resolves.toMatchObject([
        { status: 'processing' },
      ]);
      expect(f.scheduledStore.mutate).not.toHaveBeenCalled();
    },
  );
  it.each(['list', 'restore', 'download'] as const)(
    'reports sidecar storage errors from %s without leaking the volume path',
    async (operation) => {
      for (const [phase, code] of [
        ['stat', 'EACCES'],
        ['read', 'EIO'],
      ] as const) {
        const f = await fixture();
        await writeFile(join(f.directory, filename), 'PGDMPfixture');
        await writeMetadata(f.directory, 'postgresql');
        const error = Object.assign(new Error(`private-token ${f.directory}`), {
          code,
        });
        sidecarFailure[phase] = error;
        await expect(readBackupMetadata(f.directory, filename)).rejects.toBe(
          error,
        );
        const result =
          operation === 'list'
            ? f.service.list(principal)
            : operation === 'restore'
            ? f.service.restore(principal, { filename })
            : f.service.download(principal, filename);
        await expect(result).rejects.toMatchObject({ status: 500 });
        expect(f.logger.error).toHaveBeenCalledWith(
          '备份操作失败',
          'BackupService',
          {
            operation,
            reason: 'backup_operation_failed',
            code,
          },
        );
        expect(f.port.enqueue).not.toHaveBeenCalled();
        expect(JSON.stringify(f.logger.error.mock.calls)).not.toContain(
          f.directory,
        );
        expect(JSON.stringify(f.logger.error.mock.calls)).not.toContain(
          'private-token',
        );
        sidecarFailure[phase] = null;
      }
    },
  );
});

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
