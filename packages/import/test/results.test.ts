import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { ImportFileStore } from '../src/files';
import {
  ImportResultStore,
  importTaskPreview,
  normalizeImportTaskResult,
} from '../src/results';
import type { AsinImportTaskData } from '../src/task';

const directories: string[] = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'neo-import-results-'));
  directories.push(directory);
  const id = randomUUID();
  const data: AsinImportTaskData = {
    taskId: id,
    userId: 'fixture-owner',
    createdAt: '2026-09-01T00:00:00.000Z',
    taskType: 'import',
    taskSubType: 'asin',
    title: 'ASIN导入',
    file: {
      taskId: id,
      extension: 'csv',
      originalFilename: 'fixture.csv',
      bytes: 1,
      sha256: '1'.repeat(64),
    },
  };
  return { data, store: new ImportResultStore(directory), directory };
}
const result = () =>
  normalizeImportTaskResult(
    {
      total: 1,
      processedCount: 1,
      successCount: 1,
      failedCount: 0,
      missingCount: 0,
      verificationPassed: true,
    },
    'fixture.csv',
  );
const signal = () => AbortSignal.timeout(5000);
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe('full import report and bounded task metadata', () => {
  it('matches the Legacy structured task result', () => {
    const module = {
      exports: {} as {
        normalizeImportTaskResult: (...args: unknown[]) => unknown;
      },
    };
    runInNewContext(
      readFileSync(
        resolve(__dirname, '../../../server/src/services/taskResultService.js'),
        'utf8',
      ),
      { module, require: () => ({}) },
    );
    const raw = {
      total: 9,
      processedCount: 5,
      successCount: 3,
      failedCount: 2,
      missingCount: 4,
      verificationPassed: false,
      errors: [{ row: 2, message: 'fixture error' }],
    };
    expect(normalizeImportTaskResult(raw, 'fixture.csv')).toEqual(
      JSON.parse(
        JSON.stringify(
          module.exports.normalizeImportTaskResult(raw, {
            originalFilename: 'fixture.csv',
            taskSubType: 'asin',
          }),
        ),
      ),
    );
  });
  it('streams every error into valid JSON while limiting preview by actual encoded bytes', async () => {
    const { data, store } = await fixture();
    const full = normalizeImportTaskResult(
      {
        total: 1000,
        processedCount: 1000,
        successCount: 0,
        failedCount: 1000,
        missingCount: 0,
        verificationPassed: true,
        errors: Array.from({ length: 1000 }, (_, index) => ({
          row: index + 2,
          message: '问题'.repeat(1000),
        })),
      },
      'fixture.csv',
    );
    const report = await store.save(data, full, signal());
    expect(report.bytes).toBeGreaterThan(256 * 1024);
    const preview = importTaskPreview(full, report);
    expect(Buffer.byteLength(JSON.stringify(preview))).toBeLessThan(110 * 1024);
    expect(preview.errors!.length).toBeLessThan(100);
    expect(preview.errorsTruncated).toBe(true);
    expect(preview.errorCount).toBe(1000);
    expect(preview.failedCount).toBe(1000);
    expect(preview.downloadUrl).toBe(`/api/v1/tasks/${data.taskId}/download`);
    expect(preview.warnings[0]).toContain('下载完整导入结果');
    const restored = await store.read(data, signal());
    expect(restored).toEqual({ result: full, report });
    await store.verifiedPath(report, signal());
  });
  it('keeps immutable completed results for replay after a lost Redis completion acknowledgement', async () => {
    const { data, store, directory } = await fixture();
    const report = await store.save(data, result(), signal());
    await expect(
      store.save(
        data,
        { ...result(), successCount: 0, failedCount: 1 },
        signal(),
      ),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect((await store.read(data, signal()))?.result.successCount).toBe(1);
    expect(await readdir(directory)).toHaveLength(1);
    expect(
      await store.read(
        { ...data, file: { ...data.file, sha256: '2'.repeat(64) } },
        signal(),
      ),
    ).toBeNull();
    expect(importTaskPreview(result(), report)).not.toHaveProperty('errors');
  });
  it('detects report corruption and rejects path traversal', async () => {
    const { data, store } = await fixture();
    const report = await store.save(data, result(), signal());
    const path = await store.verifiedPath(report, signal());
    await writeFile(path, '{');
    await expect(store.read(data, signal())).rejects.toThrow('内容无效');
    await expect(store.verifiedPath(report, signal())).rejects.toThrow(
      '内容已改变',
    );
    await expect(
      store.verifiedPath({ ...report, taskId: '../secret' }, signal()),
    ).rejects.toThrow('引用无效');
  });
  it('lets cleanup retain reports for live task metadata while removing expired ones', async () => {
    const { data, store, directory } = await fixture();
    const report = await store.save(data, result(), signal());
    await utimes(
      await store.verifiedPath(report, signal()),
      new Date(0),
      new Date(0),
    );
    const files = new ImportFileStore(directory);
    try {
      await files.cleanup({
        olderThan: Date.now() - 1000,
        mayRemove: async (_id, kind) => kind === 'upload',
      });
      expect(await readdir(directory)).toHaveLength(1);
      await files.cleanup({
        olderThan: Date.now() - 1000,
        mayRemove: async () => true,
      });
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await files.close();
    }
  });
});
