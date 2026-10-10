import { describe, expect, it, vi } from 'vitest';
import { HttpClient } from '../lib/http';
import { jsonResponse, sessionFixture } from '../lib/transport-fixtures';
import { BackupApi } from './backup';
import {
  BACKUP_BLOB_MAX_BYTES,
  backupArchiveMaxBytes,
  backupConfigDraft,
  backupTaskOutcome,
  parseBackupFile,
} from './backup-model';
import { taskFixture } from './task-fixtures';

export const fileFixture = () => ({
  filename: 'backup_20261007-080000-01234567-primary.dump',
  format: 'custom' as const,
  target: 'primary' as const,
  size: 17,
  createdAt: '2026-10-07T00:00:00.000Z',
  timeSource: 'filename' as const,
  restoreSupported: true,
  restoreMode: 'isolated' as const,
  sourceEngine: 'postgresql' as const,
  scope: 'full' as const,
});
const taskId = '10000000-0000-4000-8000-000000000221';
function fixture() {
  const session = sessionFixture();
  const fetcher = vi.fn<typeof fetch>(async () =>
    jsonResponse({ success: true, errorCode: 0, data: [] }),
  );
  const http = new HttpClient({
    pageOrigin: 'https://app.test',
    baseURL: 'https://api.test/gateway/api/',
    session: session.store,
    fetch: fetcher,
  });
  return { fetcher, http, api: new BackupApi(http) };
}

describe('Neo backup typed transport and artifact model', () => {
  it('reads only Neo custom artifacts through normalized Cookie URLs', async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({ success: true, data: [fileFixture()] }),
    );
    expect(await f.api.list()).toEqual([
      { ...fileFixture(), description: undefined, execution: undefined },
    ]);
    expect(f.fetcher.mock.calls[0][0]).toBe(
      'https://api.test/gateway/api/v1/backup',
    );
    expect(f.fetcher.mock.calls[0][1]?.credentials).toBe('include');
    expect(f.api.downloadURL(fileFixture().filename)).toBe(
      `https://api.test/gateway/api/v1/backup/${
        fileFixture().filename
      }/download`,
    );
    expect(f.api.downloadURL(fileFixture().filename)).not.toContain(
      '/api/api/',
    );
  });
  it('rejects duplicate archive identities instead of rendering ambiguous actions', async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({ success: true, data: [fileFixture(), fileFixture()] }),
    );
    await expect(f.api.list()).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
    });
  });
  it.each([
    { filename: 'legacy.sql' },
    { target: 'competitor' },
    { format: 'sql' },
    { size: -1 },
    { restoreSupported: true, restoreMode: undefined },
    { restoreMode: 'in-place' },
    { createdAt: '2026-10-07T08:00:00' },
    { timeSource: 'dump-start' },
  ])(
    'rejects artifact drift instead of showing a recoverable row: %j',
    (change) => {
      expect(() => parseBackupFile({ ...fileFixture(), ...change })).toThrow();
    },
  );
  it('treats absent capability as unavailable and validates execution window ordering', () => {
    expect(
      parseBackupFile({ ...fileFixture(), restoreSupported: undefined })
        .restoreSupported,
    ).toBe(false);
    const execution = {
      timeSource: 'dump-start',
      dumpStartedAt: '2026-10-07T00:00:00.000Z',
      dumpCompletedAt: '2026-10-07T00:01:00.000Z',
      publicationStartedAt: '2026-10-07T00:01:01.000Z',
    };
    expect(
      parseBackupFile({ ...fileFixture(), timeSource: 'dump-start', execution })
        .execution,
    ).toEqual(execution);
    expect(() =>
      parseBackupFile({
        ...fileFixture(),
        timeSource: 'dump-start',
        execution: {
          ...execution,
          dumpCompletedAt: '2026-10-06T00:00:00.000Z',
        },
      }),
    ).toThrow();
  });
  it('submits async primary and competitor jobs and preserves a typed unknown ACK in HTTP errors', async () => {
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({ success: true, data: { taskId, status: 'pending' } }),
    );
    await f.api.submit({
      operation: 'create',
      target: 'competitor',
      description: 'fixture',
    });
    expect(JSON.parse(String(f.fetcher.mock.calls[0][1]?.body))).toEqual({
      target: 'competitor',
      description: 'fixture',
      useAsync: true,
    });
    f.fetcher.mockResolvedValueOnce(
      jsonResponse(
        {
          success: false,
          errorCode: 500,
          errorMessage: '任务提交未确认',
          data: { taskId, status: 'unknown' },
        },
        500,
      ),
    );
    await expect(
      f.api.submit({
        operation: 'restore',
        target: 'primary',
        filename: fileFixture().filename,
      }),
    ).rejects.toMatchObject({
      status: 500,
      data: { taskId, status: 'unknown' },
    });
    expect(JSON.parse(String(f.fetcher.mock.calls[1][1]?.body)).useAsync).toBe(
      true,
    );
  });
  it('never sends mismatched restore targets, SQL or synchronous result assumptions', async () => {
    const f = fixture();
    await expect(
      f.api.submit({
        operation: 'restore',
        target: 'competitor',
        filename: fileFixture().filename,
      }),
    ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
    await expect(f.api.remove('../legacy.sql')).rejects.toMatchObject({
      kind: 'INVALID_INPUT',
    });
    expect(f.fetcher).not.toHaveBeenCalled();
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({
        success: true,
        data: { filename: fileFixture().filename },
      }),
    );
    await expect(
      f.api.submit({ operation: 'create', target: 'primary' }),
    ).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
  });
  it('only accepts the bounded read-only scheduled creation view', async () => {
    const f = fixture();
    const task = taskFixture({
      taskType: 'backup',
      taskSubType: 'create',
      canCancel: false,
    });
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({ success: true, data: [task] }),
    );
    expect(await f.api.scheduled()).toEqual([task]);
    for (const change of [
      { canCancel: true },
      { taskSubType: 'restore' },
      { downloadUrl: '/file' },
    ]) {
      f.fetcher.mockResolvedValueOnce(
        jsonResponse({ success: true, data: [{ ...task, ...change }] }),
      );
      await expect(f.api.scheduled()).rejects.toMatchObject({
        kind: 'INVALID_RESPONSE',
      });
    }
  });
  it('saves Shanghai daily/weekly/monthly schedules using complete validated fields', async () => {
    const f = fixture();
    const config = {
      id: 1,
      enabled: true,
      scheduleType: 'monthly' as const,
      scheduleValue: 31,
      backupTime: '00:00',
    };
    f.fetcher.mockResolvedValueOnce(
      jsonResponse({ success: true, data: config }),
    );
    expect(await f.api.saveConfig(backupConfigDraft(config))).toMatchObject(
      config,
    );
    expect(JSON.parse(String(f.fetcher.mock.calls[0][1]?.body))).toEqual({
      enabled: true,
      scheduleType: 'monthly',
      scheduleValue: 31,
      backupTime: '00:00',
    });
    await expect(
      f.api.saveConfig({
        enabled: true,
        scheduleType: 'weekly',
        scheduleValue: 8,
        backupTime: '02:00',
      }),
    ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it('accounts for metadata and tar overhead before allowing a 256MiB fallback', () => {
    expect(backupArchiveMaxBytes(fileFixture())).toBe(
      512 + 16 * 1024 * 1024 + 2048,
    );
    expect(
      backupArchiveMaxBytes({ size: BACKUP_BLOB_MAX_BYTES }),
    ).toBeGreaterThan(BACKUP_BLOB_MAX_BYTES);
  });
  it('renders commit and verification facts rather than implying a production switch', () => {
    const task = taskFixture({
      taskType: 'backup',
      taskSubType: 'restore',
      status: 'completed',
      result: {
        operation: 'restore',
        restoreMode: 'isolated',
        targetDatabaseChanged: false,
        restoredDatabase: 'neo_restore_primary_0123456789abcdef',
        verification: 'unconfirmed',
      },
    });
    expect(backupTaskOutcome(task).join(' ')).toContain('在线目标数据库未切换');
    expect(backupTaskOutcome(task).join(' ')).toContain('验证尚未确认');
    expect(
      backupTaskOutcome({
        ...task,
        result: {
          operation: 'restore',
          restoreMode: 'in-place',
          targetDatabaseChanged: true,
          verification: 'unconfirmed',
        },
      }).join(' '),
    ).toContain('在线目标数据库已变更');
  });
});
