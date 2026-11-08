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
  it.each(['timeout', 'session'] as const)(
    'retains 64 physical file aborts after timely %s results and releases only a settled slot',
    async (reason) => {
      vi.useFakeTimers();
      const f = fixture();
      f.fetcher.mockImplementation(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({}, { highWaterMark: 0 }),
            {
              headers: { 'content-type': mime },
            },
          ),
      );
      const aborts = Array.from({ length: 64 }, () => deferred<void>());
      const sinks = aborts.map((gate) => ({
        write: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
        abort: vi.fn(() => gate.promise),
      }));
      const options = {
        timeoutMs: 10,
        minBytes: 4,
        maxBytes: 4,
        expectedType: mime,
      };
      const calls = sinks.map((sink) =>
        f.http
          .downloadTo(`/api/v1/tasks/${id}/download`, sink, options)
          .catch((error: unknown) => error),
      );
      await vi.advanceTimersByTimeAsync(0);
      if (reason === 'session') f.http.cancelAll();
      await vi.advanceTimersByTimeAsync(10);
      expect(
        (await Promise.all(calls)).every(
          (error) =>
            error instanceof Error &&
            'kind' in error &&
            error.kind === (reason === 'timeout' ? 'TIMEOUT' : 'CANCELLED'),
        ),
      ).toBe(true);
      for (const sink of sinks) expect(sink.abort).toHaveBeenCalledOnce();
      const overflow = f.http
        .downloadTo('/api/v1/overflow', f.sink, options)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);
      expect(await overflow).toMatchObject({ kind: 'CAPACITY' });
      expect(f.fetcher).toHaveBeenCalledTimes(64);
      if (reason === 'session')
        aborts[0].reject(new Error('Native abort refused'));
      else aborts[0].resolve();
      await vi.advanceTimersByTimeAsync(0);
      const replacement = f.http
        .downloadTo('/api/v1/replacement', f.sink, {
          ...options,
          timeoutMs: 1000,
        })
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.fetcher).toHaveBeenCalledTimes(65);
      await expect(
        f.http.downloadTo('/api/v1/second-overflow', f.sink, options),
      ).rejects.toMatchObject({ kind: 'CAPACITY' });
      f.http.cancelAll();
      for (const gate of aborts) gate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      await replacement;
      for (const sink of sinks) expect(sink.abort).toHaveBeenCalledOnce();
    },
  );
  it.each([
    ['write', 'operation'],
    ['close', 'operation'],
    ['write', 'abort'],
    ['close', 'abort'],
  ] as const)(
    'retains native %s and abort until both settle when %s finishes first',
    async (phase, first) => {
      vi.useFakeTimers();
      const f = fixture();
      const operations = Array.from({ length: 64 }, () => deferred<void>());
      const aborts = Array.from({ length: 64 }, () => deferred<void>());
      const sinks = operations.map((operation, index) => ({
        write: vi.fn(() =>
          phase === 'write' ? operation.promise : Promise.resolve(),
        ),
        close: vi.fn(() =>
          phase === 'close' ? operation.promise : Promise.resolve(),
        ),
        abort: vi.fn(() => aborts[index].promise),
      }));
      const options = {
        timeoutMs: 10,
        minBytes: 4,
        maxBytes: 4,
        expectedType: mime,
      };
      const callers = sinks.map((sink) =>
        f.http
          .downloadTo('/api/v1/download', sink, options)
          .catch((error: unknown) => error),
      );
      await vi.advanceTimersByTimeAsync(0);
      for (const sink of sinks) expect(sink[phase]).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10);
      expect(
        (await Promise.all(callers)).every(
          (error) =>
            error instanceof Error &&
            'kind' in error &&
            error.kind === 'TIMEOUT',
        ),
      ).toBe(true);
      if (first === 'operation')
        for (const operation of operations) operation.resolve();
      else for (const gate of aborts) gate.resolve();
      await vi.advanceTimersByTimeAsync(0);
      const overflow = f.http
        .downloadTo('/api/v1/overflow', f.sink, options)
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(10);
      expect(await overflow).toMatchObject({ kind: 'CAPACITY' });
      expect(f.fetcher).toHaveBeenCalledTimes(64);
      if (first === 'operation') aborts[0].resolve();
      else operations[0].resolve();
      await vi.advanceTimersByTimeAsync(0);
      await expect(
        f.http.downloadTo('/api/v1/released', f.sink, options),
      ).resolves.toBe(4);
      for (const gate of aborts) gate.resolve();
      for (const operation of operations) operation.resolve();
      await vi.advanceTimersByTimeAsync(0);
      for (const sink of sinks) expect(sink.abort).toHaveBeenCalledOnce();
      if (phase === 'write')
        for (const sink of sinks) expect(sink.close).not.toHaveBeenCalled();
    },
  );
  it('preserves AUTH during session reset and retains its outstanding native abort', async () => {
    const f = fixture(),
      aborting = deferred<void>();
    vi.mocked(f.sink.abort).mockReturnValueOnce(aborting.promise);
    f.fetcher.mockResolvedValueOnce(jsonResponse({ success: false }, 401));
    f.unauthorized.mockImplementation(() => f.http.cancelAll());
    await expect(
      f.tasks.downloadAsinExportTo(exported(), f.sink),
    ).rejects.toMatchObject({ kind: 'AUTH', status: 401 });
    expect(f.unauthorized).toHaveBeenCalledOnce();
    expect(f.sink.abort).toHaveBeenCalledOnce();
    aborting.resolve();
  });
  it('does not start a second abort after final close physically finishes with a stale scope', async () => {
    const f = fixture();
    let current = true;
    vi.mocked(f.sink.close).mockImplementation(async () => {
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
    expect(f.sink.close).toHaveBeenCalledOnce();
    expect(f.sink.abort).not.toHaveBeenCalled();
  });
  it('aborts a late acquired writable before GET after caller cancellation', async () => {
    vi.useFakeTimers();
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
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    opening.resolve(f.sink);
    await expect(work).rejects.toMatchObject({ kind: 'CANCELLED' });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.sink.abort).toHaveBeenCalledOnce();
    expect(f.sink.close).not.toHaveBeenCalled();
  });
  it.each(['resolve', 'reject'] as const)(
    'cancels promptly during 64 native opens and releases only a physically %s opening',
    async (settlement) => {
      vi.useFakeTimers();
      const f = fixture();
      const openings = Array.from({ length: 64 }, () =>
        deferred<DownloadSink>(),
      );
      const controllers = openings.map(() => new AbortController());
      const creators = openings.map((gate) => vi.fn(() => gate.promise));
      const saves = openings.map((_, index) =>
        saveToFile(
          { createWritable: creators[index] },
          controllers[index].signal,
          () => true,
          async (sink, signal) =>
            (await f.tasks.downloadAsinExportTo(exported(), sink, signal))
              .bytes,
        ).catch((error: unknown) => error),
      );
      await vi.advanceTimersByTimeAsync(0);
      for (const controller of controllers) controller.abort();
      expect(
        (await Promise.all(saves)).every(
          (error) =>
            error instanceof Error &&
            'kind' in error &&
            error.kind === 'CANCELLED',
        ),
      ).toBe(true);
      const extra = vi.fn(async () => f.sink);
      await expect(
        saveToFile(
          { createWritable: extra },
          new AbortController().signal,
          () => true,
          async () => 4,
        ),
      ).rejects.toMatchObject({ kind: 'CAPACITY' });
      expect(extra).not.toHaveBeenCalled();
      expect(f.fetcher).not.toHaveBeenCalled();
      if (settlement === 'resolve') openings[0].resolve(f.sink);
      else openings[0].reject(new Error('late native opening rejection'));
      await vi.advanceTimersByTimeAsync(0);
      expect(f.sink.abort).toHaveBeenCalledTimes(
        settlement === 'resolve' ? 1 : 0,
      );
      await expect(
        saveToFile(
          { createWritable: extra },
          new AbortController().signal,
          () => true,
          async (sink) => {
            await sink.close();
            return 4;
          },
        ),
      ).resolves.toBe(4);
      expect(extra).toHaveBeenCalledOnce();
      for (const opening of openings.slice(1))
        opening.reject(new Error('fixture shutdown'));
      await vi.advanceTimersByTimeAsync(0);
    },
  );
  it('returns the 30 minute deadline while a native opening ignores cancellation and aborts its late writable once', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      opening = deferred<DownloadSink>();
    const saved = saveToFile(
      { createWritable: () => opening.promise },
      new AbortController().signal,
      () => true,
      async (sink, signal) =>
        (await f.tasks.downloadAsinExportTo(exported(), sink, signal)).bytes,
    );
    const rejected = expect(saved).rejects.toMatchObject({ kind: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await rejected;
    expect(f.fetcher).not.toHaveBeenCalled();
    opening.resolve(f.sink);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.sink.abort).toHaveBeenCalledOnce();
    expect(f.sink.close).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
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
