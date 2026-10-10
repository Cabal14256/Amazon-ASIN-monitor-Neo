import { createHash } from 'node:crypto';
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
  // This is a portable tar fixture, not a real pg_dump/restore proof.
  const dump = new Uint8Array(size);
  dump.set(new TextEncoder().encode('PGDMPfixture-221!').subarray(0, size));
  const metadata = new TextEncoder().encode(
    JSON.stringify({
      version: 3,
      filename,
      target: 'primary',
      sourceEngine: 'postgresql',
      scope: 'full',
      archiveSha256: createHash('sha256').update(dump).digest('hex'),
      databaseSettings: {
        encoding: 'UTF8',
        lcCollate: 'C',
        lcCtype: 'C',
        localeProvider: 'libc',
      },
    }),
  );
  const members = [
    { name: filename, body: dump },
    { name: `${filename}.meta.json`, body: metadata },
  ];
  const total = members.reduce(
    (bytes, member) => bytes + 512 + Math.ceil(member.body.length / 512) * 512,
    1024,
  );
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const member of members) {
    const header = bytes.subarray(offset, offset + 512);
    const text = (value: string, start: number) =>
      header.set(new TextEncoder().encode(value), start);
    text(member.name, 0);
    text('0000600\0', 100);
    text('0000000\0', 108);
    text('0000000\0', 116);
    text(member.body.length.toString(8).padStart(11, '0') + '\0', 124);
    text('00000000000\0', 136);
    header.fill(32, 148, 156);
    header[156] = 48;
    text('ustar\0', 257);
    text('00', 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    text(checksum.toString(8).padStart(6, '0') + '\0 ', 148);
    bytes.set(member.body, offset + 512);
    offset += 512 + Math.ceil(member.body.length / 512) * 512;
  }
  return bytes;
}

/** Inspect saved fixture bytes independently of the production prefix check. */
function unpackFixtureBundle(bytes: Uint8Array) {
  const members: { name: string; body: Uint8Array }[] = [];
  const text = (field: Uint8Array) =>
    new TextDecoder().decode(field).replace(/\0.*$/, '').trim();
  let offset = 0;
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = parseInt(text(header.subarray(124, 136)), 8);
    const expectedChecksum = parseInt(text(header.subarray(148, 156)), 8);
    const actualChecksum = header.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    const bodyStart = offset + 512;
    const next = bodyStart + Math.ceil(size / 512) * 512;
    if (
      !Number.isSafeInteger(size) || size < 0 ||
      actualChecksum !== expectedChecksum || header[156] !== 48 ||
      text(header.subarray(257, 263)) !== 'ustar' ||
      next > bytes.length ||
      !bytes.subarray(bodyStart + size, next).every((byte) => byte === 0)
    ) throw new Error('INVALID_FIXTURE_TAR');
    members.push({ name: text(header.subarray(0, 100)), body: bytes.slice(bodyStart, bodyStart + size) });
    offset = next;
  }
  if (
    members.length !== 2 ||
    members[1].name !== `${members[0].name}.meta.json` ||
    bytes.length - offset !== 1024 ||
    !bytes.subarray(offset).every((byte) => byte === 0)
  ) throw new Error('INCOMPLETE_FIXTURE_BUNDLE');
  const metadata = JSON.parse(new TextDecoder().decode(members[1].body));
  expect(metadata).toMatchObject({
    version: 3, filename: members[0].name, target: 'primary',
    sourceEngine: 'postgresql', scope: 'full',
    archiveSha256: createHash('sha256').update(members[0].body).digest('hex'),
  });
  return { members, metadata };
}

// Later native/backend probes may use these negatives. They are outside the
// current transport contract (first tar header + bounded byte count), so this
// preparation does not invent a client-side sidecar-validation requirement.
function incompleteArchiveFixtures() {
  const missingMetadata = archive();
  missingMetadata.fill(0, 1024);
  const truncatedMetadata = archive().slice(0, 2560);
  return [
    { name: 'missing metadata entry', bytes: missingMetadata },
    { name: 'trailer truncation above the transport byte floor', bytes: truncatedMetadata },
  ];
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
    const expected = archive();
    expect(result).toBe(expected.length);
    expect(f.sink.write).toHaveBeenCalledOnce();
    expect(f.sink.close).toHaveBeenCalledOnce();
    const saved = (f.sink.write as ReturnType<typeof vi.fn>).mock.calls[0][0] as Uint8Array;
    expect(saved).toEqual(expected);
    const { members } = unpackFixtureBundle(saved);
    expect(members.map((member) => member.name)).toEqual([file.filename, `${file.filename}.meta.json`]);
    expect(new TextDecoder().decode(members[0].body)).toBe('PGDMPfixture-221!');
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
    expect(progress).toHaveBeenLastCalledWith(expected.length);
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
    const saved = new Uint8Array(await (save.mock.calls[0][0] as Blob).arrayBuffer());
    expect(saved).toEqual(archive());
    expect(unpackFixtureBundle(saved).members).toHaveLength(2);
    expect(() =>
      chooseBackupDestination({ ...file, size: BACKUP_BLOB_MAX_BYTES }),
    ).toThrow('支持');
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it.each(incompleteArchiveFixtures())(
    'distinguishes $name in fixture inspection without extending the transport contract',
    ({ bytes }) => {
      expect(bytes.length).toBeGreaterThanOrEqual(Math.ceil(file.size / 512) * 512 + 2048);
      expect(() => validateBackupTarPrefix(bytes.subarray(0, 512), file)).not.toThrow();
      expect(() => unpackFixtureBundle(bytes)).toThrow();
    },
  );
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
