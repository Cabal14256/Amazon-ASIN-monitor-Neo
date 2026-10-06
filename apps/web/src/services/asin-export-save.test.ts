import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DownloadSink } from '../lib/download-stream';
import { chooseFileSave, saveToFile } from '../lib/file-save';
import { HttpClient } from '../lib/http';
import {
  deferred,
  jsonResponse,
  sessionFixture,
} from '../lib/transport-fixtures';
import { TaskMessageFixture, taskFixture } from './task-fixtures';
import { TaskApi } from './tasks';

const id = '123e4567-e89b-42d3-a456-426614174000';
const mime =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const exported = (bytes = 4) =>
  taskFixture({
    taskId: id,
    taskType: 'export',
    taskSubType: 'asin',
    status: 'completed',
    filename: 'ASIN数据_2026-10-07.xlsx',
    downloadUrl: `/api/v1/tasks/${id}/download`,
    result: {
      exportType: 'asin',
      filename: 'ASIN数据_2026-10-07.xlsx',
      mimeType: mime,
      fileSizeBytes: bytes,
      artifact: {
        taskId: id,
        key: `export-${id}.xlsx`,
        bytes,
        sha256: 'a'.repeat(64),
      },
    },
  });
const response = (
  bytes: Uint8Array<ArrayBuffer> = new Uint8Array([80, 75, 3, 4]),
  headers: Record<string, string> = {},
) => new Response(bytes, { headers: { 'content-type': mime, ...headers } });
const clients: HttpClient[] = [];
function fixture() {
  const session = sessionFixture();
  const fetcher = vi.fn<typeof fetch>(async () => response());
  const unauthorized = vi.fn();
  const http = new HttpClient({
    baseURL: 'https://api.test/gateway/api/',
    pageOrigin: 'https://app.test',
    session: session.store,
    fetch: fetcher,
    onUnauthorized: unauthorized,
  });
  clients.push(http);
  const sink: DownloadSink = {
    write: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
    abort: vi.fn(async () => undefined),
  };
  return {
    ...session,
    fetcher,
    http,
    unauthorized,
    sink,
    tasks: new TaskApi(http, new TaskMessageFixture()),
  };
}
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  vi.useRealTimers();
});

describe('ASIN workbook authenticated bounded file saves', () => {
  it('streams through one normalized Cookie/Bearer URL and verifies before final close', async () => {
    const f = fixture();
    f.local.set('token', 'fixture-legacy');
    expect(await f.tasks.downloadAsinExportTo(exported(), f.sink)).toEqual({
      filename: 'ASIN数据_2026-10-07.xlsx',
      bytes: 4,
    });
    expect(f.fetcher.mock.calls[0][0]).toBe(
      `https://api.test/gateway/api/v1/tasks/${id}/download`,
    );
    expect(f.fetcher.mock.calls[0][1]).toMatchObject({
      credentials: 'include',
      redirect: 'error',
    });
    expect(
      new Headers(f.fetcher.mock.calls[0][1]?.headers).get('authorization'),
    ).toBe('Bearer fixture-legacy');
    expect(f.sink.write).toHaveBeenCalledOnce();
    expect(f.sink.close).toHaveBeenCalledOnce();
    expect(f.sink.abort).not.toHaveBeenCalled();
  });
  it('waits for the first disk write before requesting another stream chunk', async () => {
    const f = fixture(),
      writing = deferred<void>();
    let pulls = 0;
    f.fetcher.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulls++;
              controller.enqueue(
                pulls === 1
                  ? new Uint8Array([80, 75, 3, 4])
                  : new Uint8Array([1, 2, 3, 4]),
              );
              if (pulls === 2) controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { 'content-type': mime } },
      ),
    );
    vi.mocked(f.sink.write).mockImplementationOnce(() => writing.promise);
    const saved = f.tasks.downloadAsinExportTo(exported(8), f.sink);
    await vi.waitFor(() => expect(f.sink.write).toHaveBeenCalledOnce());
    expect(pulls).toBe(1);
    expect(f.sink.close).not.toHaveBeenCalled();
    writing.resolve();
    await expect(saved).resolves.toMatchObject({ bytes: 8 });
    expect(pulls).toBe(2);
    expect(f.sink.close).toHaveBeenCalledOnce();
  });
  it('supports exactly 256 MiB using a reused 8 MiB producer chunk and a counting disk sink', async () => {
    const f = fixture(),
      chunk = new Uint8Array(8 * 1024 * 1024);
    chunk.set([80, 75, 3, 4]);
    let pulls = 0,
      written = 0;
    f.fetcher.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              pulls++;
              controller.enqueue(chunk);
              if (pulls === 32) controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
        {
          headers: {
            'content-type': mime,
            'content-length': String(256 * 1024 * 1024),
          },
        },
      ),
    );
    f.sink.write = async (bytes) => {
      written += bytes.byteLength;
    };
    expect(
      await f.tasks.downloadAsinExportTo(exported(256 * 1024 * 1024), f.sink),
    ).toMatchObject({ bytes: 256 * 1024 * 1024 });
    expect(pulls).toBe(32);
    expect(written).toBe(256 * 1024 * 1024);
    expect(f.sink.close).toHaveBeenCalledOnce();
  });
  it.each([
    () => response(new Uint8Array([80, 75, 3, 4, 0])),
    () => response(new Uint8Array([80, 75, 3])),
    () => response(new Uint8Array([1, 2, 3, 4])),
    () => response(undefined, { 'content-length': '5' }),
    () => response(undefined, { 'content-length': '-4' }),
    () => response(undefined, { 'content-type': 'application/json' }),
  ])(
    'aborts a successful HTTP body with inconsistent size/type/ZIP identity and never closes it',
    async (body) => {
      const f = fixture();
      f.fetcher.mockResolvedValueOnce(body());
      await expect(
        f.tasks.downloadAsinExportTo(exported(), f.sink),
      ).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
      expect(f.sink.close).not.toHaveBeenCalled();
      expect(f.sink.abort).toHaveBeenCalledOnce();
    },
  );
  it('accepts the unsigned byte view from another JavaScript realm', async () => {
    const f = fixture();
    const bytes: Uint8Array<ArrayBuffer> = runInNewContext(
      'new Uint8Array([80,75,3,4])',
    );
    f.fetcher.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        { headers: { 'content-type': mime } },
      ),
    );
    await expect(
      f.tasks.downloadAsinExportTo(exported(), f.sink),
    ).resolves.toMatchObject({ bytes: 4 });
  });
  it.each([401, 403, 404])(
    'preserves HTTP %s failures and aborts the file sink without replay',
    async (status) => {
      const f = fixture();
      f.fetcher.mockResolvedValueOnce(
        jsonResponse({ success: false, errorMessage: '文件不可用' }, status),
      );
      await expect(
        f.tasks.downloadAsinExportTo(exported(), f.sink),
      ).rejects.toMatchObject({
        kind: status === 401 ? 'AUTH' : 'HTTP',
        status,
      });
      expect(f.fetcher).toHaveBeenCalledOnce();
      expect(f.sink.abort).toHaveBeenCalledOnce();
      expect(f.sink.close).not.toHaveBeenCalled();
      expect(f.unauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    },
  );
  it('preserves the 30 minute deadline while allowing a slow body beyond 125 seconds', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.fetcher.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([80]));
            setTimeout(() => {
              controller.enqueue(new Uint8Array([75, 3, 4]));
              controller.close();
            }, 126_000);
          },
        }),
        { headers: { 'content-type': mime } },
      ),
    );
    const work = f.tasks.downloadAsinExportTo(exported(), f.sink);
    await vi.advanceTimersByTimeAsync(125_001);
    expect(f.sink.close).not.toHaveBeenCalled();
    expect(f.fetcher.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(999);
    await expect(work).resolves.toMatchObject({ bytes: 4 });
  });
  it('settles the transfer timeout even if the final close and disk abort ignore cancellation', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      closing = deferred<void>(),
      aborting = deferred<void>();
    vi.mocked(f.sink.close).mockReturnValueOnce(closing.promise);
    vi.mocked(f.sink.abort).mockReturnValueOnce(aborting.promise);
    const work = saveToFile(
      { createWritable: async () => f.sink },
      new AbortController().signal,
      () => true,
      async (sink) =>
        (await f.tasks.downloadAsinExportTo(exported(), sink)).bytes,
    );
    const rejected = expect(work).rejects.toMatchObject({ kind: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sink.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await rejected;
    expect(f.sink.abort).toHaveBeenCalledOnce();
    closing.resolve();
    aborting.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });
  it('aborts a late acquired writable before GET after caller cancellation', async () => {
    const f = fixture(),
      opening = deferred<DownloadSink>(),
      controller = new AbortController();
    const work = saveToFile(
      { createWritable: () => opening.promise },
      controller.signal,
      () => true,
      async (sink) =>
        (await f.tasks.downloadAsinExportTo(exported(), sink)).bytes,
    );
    controller.abort();
    opening.resolve(f.sink);
    await expect(work).rejects.toMatchObject({ kind: 'CANCELLED' });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.sink.abort).toHaveBeenCalledOnce();
    expect(f.sink.close).not.toHaveBeenCalled();
  });
  it('does not close a file if the live owner/permission guard changes during write', async () => {
    const f = fixture();
    let current = true;
    vi.mocked(f.sink.write).mockImplementationOnce(async () => {
      current = false;
    });
    await expect(
      saveToFile(
        { createWritable: async () => f.sink },
        new AbortController().signal,
        () => current,
        async (sink) =>
          (
            await f.tasks.downloadAsinExportTo(exported(), sink)
          ).bytes,
      ),
    ).rejects.toMatchObject({ kind: 'CANCELLED' });
    expect(f.sink.abort).toHaveBeenCalledOnce();
    expect(f.sink.close).not.toHaveBeenCalled();
  });
  it('keeps the smaller Blob fallback bound before any GET and caps actual bytes at the original receipt', async () => {
    const f = fixture();
    await expect(
      f.tasks.downloadAsinExport(exported(32 * 1024 * 1024 + 1)),
    ).rejects.toMatchObject({ kind: 'INVALID_INPUT' });
    expect(f.fetcher).not.toHaveBeenCalled();
    f.fetcher.mockResolvedValueOnce(
      response(new Uint8Array([80, 75, 3, 4, 0])),
    );
    await expect(f.tasks.downloadAsinExport(exported())).rejects.toMatchObject({
      kind: 'INVALID_RESPONSE',
    });
    await expect(
      chooseFileSave(
        'ASIN数据_2026-10-07.xlsx',
        32 * 1024 * 1024,
        mime,
        '.xlsx',
        undefined,
      ),
    ).resolves.toMatchObject({ kind: 'blob' });
    expect(() =>
      chooseFileSave(
        'ASIN数据_2026-10-07.xlsx',
        32 * 1024 * 1024 + 1,
        mime,
        '.xlsx',
        undefined,
      ),
    ).toThrow('32 MiB');
  });
});
