import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DownloadSink } from '../lib/download-stream';
import { ApiError, HttpClient } from '../lib/http';
import {
  deferred,
  jsonResponse,
  sessionFixture,
} from '../lib/transport-fixtures';
import { BackupApi } from './backup';
import {
  chooseBackupDestination,
  downloadBackup,
  validateBackupTarPrefix,
} from './backup-download';
import { BACKUP_BLOB_MAX_BYTES, type BackupFile } from './backup-model';

const file: BackupFile = {
  filename: 'backup_20261007-080000-01234567-primary.dump',
  format: 'custom',
  target: 'primary',
  size: 17,
  createdAt: '2026-10-07T00:00:00.000Z',
  timeSource: 'filename',
  restoreSupported: false,
};
function archive(
  filename = file.filename,
  size = file.size,
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(3072);
  bytes.set(new TextEncoder().encode(filename));
  bytes.set(
    new TextEncoder().encode(size.toString(8).padStart(11, '0') + '\0'),
    124,
  );
  bytes.fill(32, 148, 156);
  bytes[156] = 48;
  const sum = bytes.subarray(0, 512).reduce((total, value) => total + value, 0);
  bytes.set(
    new TextEncoder().encode(sum.toString(8).padStart(6, '0') + '\0 '),
    148,
  );
  return bytes;
}
const clients: HttpClient[] = [];
function fixture(body = archive()) {
  const session = sessionFixture();
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(body);
            controller.close();
          },
        }),
        { headers: { 'content-type': 'application/x-tar' } },
      ),
  );
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
    api: new BackupApi(http),
    sink,
    unauthorized,
  };
}
afterEach(() => {
  for (const client of clients.splice(0)) client.close();
  vi.useRealTimers();
});

describe('bounded backup streaming save', () => {
  it('opens the save picker synchronously in the gesture before any file/network work', async () => {
    const f = fixture();
    const handle = { createWritable: vi.fn(async () => f.sink) };
    const picker = vi.fn(async () => handle);
    const selected = chooseBackupDestination(file, picker);
    expect(picker).toHaveBeenCalledOnce();
    expect(handle.createWritable).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
    const destination = await selected;
    expect(destination.filename).toBe(file.filename.replace('.dump', '.tar'));
  });
  it('writes one chunk at a time through the normalized authenticated URL and closes only after validation', async () => {
    const f = fixture();
    f.local.set('token', 'fixture-legacy');
    const progress = vi.fn();
    const result = await downloadBackup(
      f.http,
      f.api,
      file,
      {
        kind: 'file',
        filename: file.filename.replace('.dump', '.tar'),
        handle: { createWritable: async () => f.sink },
      },
      new AbortController().signal,
      () => true,
      progress,
    );
    expect(result).toBe(3072);
    expect(f.sink.write).toHaveBeenCalledOnce();
    expect(f.sink.close).toHaveBeenCalledOnce();
    expect(f.fetcher.mock.calls[0][0]).toBe(
      `https://api.test/gateway/api/v1/backup/${file.filename}/download`,
    );
    expect(f.fetcher.mock.calls[0][1]).toMatchObject({
      credentials: 'include',
      redirect: 'error',
    });
    expect(
      new Headers(f.fetcher.mock.calls[0][1]?.headers).get('authorization'),
    ).toBe('Bearer fixture-legacy');
    expect(progress).toHaveBeenLastCalledWith(3072);
  });
  it('honors disk backpressure without reading ahead in the consumer', async () => {
    const f = fixture();
    const wait = deferred<void>();
    let reads = 0;
    const data = archive();
    f.fetcher.mockResolvedValueOnce(
      new Response(
        new ReadableStream<Uint8Array>(
          {
            pull(controller) {
              reads++;
              controller.enqueue(
                data.subarray(
                  reads === 1 ? 0 : 512,
                  reads === 1 ? 512 : data.length,
                ),
              );
              if (reads === 2) controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
        { headers: { 'content-type': 'application/x-tar' } },
      ),
    );
    (f.sink.write as ReturnType<typeof vi.fn>).mockImplementationOnce(
      () => wait.promise,
    );
    const work = downloadBackup(
      f.http,
      f.api,
      file,
      {
        kind: 'file',
        filename: file.filename.replace('.dump', '.tar'),
        handle: { createWritable: async () => f.sink },
      },
      new AbortController().signal,
      () => true,
      vi.fn(),
    );
    await vi.waitFor(() => expect(f.sink.write).toHaveBeenCalledOnce());
    expect(reads).toBe(1);
    expect(f.sink.close).not.toHaveBeenCalled();
    wait.resolve();
    await work;
    expect(reads).toBe(2);
  });
  it('uses bounded Blob fallback only when the complete archive upper bound fits', async () => {
    const f = fixture();
    const save = vi.fn();
    const destination = await chooseBackupDestination(file);
    expect(destination.kind).toBe('blob');
    await downloadBackup(
      f.http,
      f.api,
      file,
      destination,
      new AbortController().signal,
      () => true,
      vi.fn(),
      save,
    );
    expect(save).toHaveBeenCalledOnce();
    expect((save.mock.calls[0][0] as Blob).size).toBe(3072);
    expect(() =>
      chooseBackupDestination({ ...file, size: BACKUP_BLOB_MAX_BYTES }),
    ).toThrow('支持');
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it.each([
    archive('different.dump'),
    archive(file.filename, 18),
    new Uint8Array(512),
  ])(
    'rejects selected artifact/header drift before output commit',
    async (body) => {
      const f = fixture(body);
      await expect(
        downloadBackup(
          f.http,
          f.api,
          file,
          {
            kind: 'file',
            filename: file.filename.replace('.dump', '.tar'),
            handle: { createWritable: async () => f.sink },
          },
          new AbortController().signal,
          () => true,
          vi.fn(),
        ),
      ).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
      expect(f.sink.close).not.toHaveBeenCalled();
      expect(f.sink.abort).toHaveBeenCalled();
    },
  );
  it('bounds announced and actual bytes even when Content-Length is missing', async () => {
    const f = fixture();
    const options = {
      timeoutMs: 1000,
      maxBytes: 2,
      minBytes: 1,
      expectedType: 'application/x-tar',
    };
    await expect(
      f.http.downloadTo('/api/v1/backup/file/download', f.sink, options),
    ).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    expect(f.sink.close).not.toHaveBeenCalled();
    f.fetcher.mockResolvedValueOnce(
      new Response('x', {
        headers: { 'content-type': 'application/x-tar', 'content-length': '3' },
      }),
    );
    await expect(
      f.http.downloadTo('/api/v1/backup/file/download', f.sink, options),
    ).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
  });
  it('aborts the output on disk failure, cancellation and live permission loss', async () => {
    const f = fixture();
    let allowed = true;
    (f.sink.write as ReturnType<typeof vi.fn>).mockImplementationOnce(
      async () => {
        allowed = false;
      },
    );
    await expect(
      downloadBackup(
        f.http,
        f.api,
        file,
        {
          kind: 'file',
          filename: file.filename.replace('.dump', '.tar'),
          handle: { createWritable: async () => f.sink },
        },
        new AbortController().signal,
        () => allowed,
        vi.fn(),
      ),
    ).rejects.toMatchObject({ kind: 'CANCELLED' });
    expect(f.sink.close).not.toHaveBeenCalled();
    expect(f.sink.abort).toHaveBeenCalled();
    const next = fixture();
    (next.sink.write as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('disk full'),
    );
    await expect(
      downloadBackup(
        next.http,
        next.api,
        file,
        {
          kind: 'file',
          filename: file.filename.replace('.dump', '.tar'),
          handle: { createWritable: async () => next.sink },
        },
        new AbortController().signal,
        () => true,
        vi.fn(),
      ),
    ).rejects.toMatchObject({ kind: 'NETWORK' });
    expect(next.sink.close).not.toHaveBeenCalled();
    expect(next.sink.abort).toHaveBeenCalled();
  });
  it('cancels a late writable acquisition without starting GET or overwriting the chosen file', async () => {
    const f = fixture(),
      opening = deferred<DownloadSink>(),
      controller = new AbortController();
    const work = downloadBackup(
      f.http,
      f.api,
      file,
      {
        kind: 'file',
        filename: file.filename.replace('.dump', '.tar'),
        handle: { createWritable: () => opening.promise },
      },
      controller.signal,
      () => true,
      vi.fn(),
    );
    controller.abort();
    opening.resolve(f.sink);
    await expect(work).rejects.toMatchObject({ kind: 'CANCELLED' });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.sink.abort).toHaveBeenCalled();
  });
  it('enforces the deadline against a non-cooperating fetch and ignores its late body', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      pending = deferred<Response>();
    f.fetcher.mockReturnValueOnce(pending.promise);
    const work = f.http.downloadTo('/api/v1/backup/file/download', f.sink, {
      timeoutMs: 500,
      maxBytes: 4000,
      minBytes: 1,
      expectedType: 'application/x-tar',
    });
    const failed = expect(work).rejects.toMatchObject({ kind: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(500);
    await failed;
    pending.resolve(
      new Response(archive(), {
        headers: { 'content-type': 'application/x-tar' },
      }),
    );
    await vi.advanceTimersByTimeAsync(1);
    expect(f.sink.write).not.toHaveBeenCalled();
    expect(f.sink.close).not.toHaveBeenCalled();
    expect(f.sink.abort).toHaveBeenCalled();
  });
  it('uses runtime cancelAll for session cleanup and preserves HTTP authorization failures', async () => {
    const f = fixture(),
      pending = deferred<Response>();
    f.fetcher.mockReturnValueOnce(pending.promise);
    const work = f.http.downloadTo('/api/v1/backup/file/download', f.sink, {
      timeoutMs: 1000,
      maxBytes: 4000,
      minBytes: 1,
      expectedType: 'application/x-tar',
    });
    const failed = expect(work).rejects.toMatchObject({ kind: 'CANCELLED' });
    f.http.cancelAll();
    await failed;
    pending.resolve(new Response(archive()));
    const next = fixture();
    next.fetcher.mockResolvedValueOnce(
      jsonResponse({ success: false, errorCode: 401 }, 401),
    );
    await expect(
      next.http.downloadTo('/api/v1/backup/file/download', next.sink, {
        timeoutMs: 1000,
        maxBytes: 4000,
        minBytes: 1,
        expectedType: 'application/x-tar',
      }),
    ).rejects.toMatchObject({ kind: 'AUTH', status: 401 });
    expect(next.unauthorized).toHaveBeenCalledOnce();
    expect(next.sink.abort).toHaveBeenCalled();
  });
  it('rejects oversized/perversely signed tar size headers deterministically', () => {
    const header = archive().subarray(0, 512);
    header[124] = 255;
    expect(() => validateBackupTarPrefix(header, file)).toThrow(ApiError);
  });
  it('accepts an exact 10 GiB GNU base-256 tar size without allocating a large payload', () => {
    const large = { ...file, size: 10 * 1024 ** 3 };
    const header = archive().subarray(0, 512);
    header.fill(0, 124, 136);
    let remaining = BigInt(large.size);
    for (let index = 135; index >= 124; index--) {
      header[index] = Number(remaining & 255n);
      remaining >>= 8n;
    }
    header[124] |= 128;
    header.fill(32, 148, 156);
    const sum = header.reduce((total, value) => total + value, 0);
    header.set(
      new TextEncoder().encode(sum.toString(8).padStart(6, '0') + '\0 '),
      148,
    );
    expect(() => validateBackupTarPrefix(header, large)).not.toThrow();
    expect(() =>
      validateBackupTarPrefix(header, { ...large, size: large.size - 1 }),
    ).toThrow(ApiError);
  });
});
