import { describe, expect, it } from 'vitest';
import { writeDownloadStream } from './download-stream';

describe('streamed backup byte budget', () => {
  it('accepts a permitted archive with more than 200000 normal 64 KiB chunks', async () => {
    const chunk = new Uint8Array(64 * 1024);
    const count = 200001;
    let produced = 0;
    let written = 0;
    let closed = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (produced++ < count) controller.enqueue(chunk);
          else controller.close();
        },
      }),
      {
        headers: {
          'content-type': 'application/x-tar',
          'content-length': String(count * chunk.byteLength),
        },
      },
    );
    const result = await writeDownloadStream(
      response,
      {
        async write(bytes) {
          written += bytes.byteLength;
        },
        async close() {
          closed = true;
        },
        async abort() {},
      },
      {
        timeoutMs: 30 * 60_000,
        minBytes: count * chunk.byteLength,
        maxBytes: 1024 ** 4,
        expectedType: 'application/x-tar',
      },
      new AbortController().signal,
    );
    expect(result).toBe(count * chunk.byteLength);
    expect(written).toBe(result);
    expect(closed).toBe(true);
  });
  it('rejects streams that never make byte progress within the finite empty-read bound', async () => {
    let produced = 0;
    let cancelled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          produced++;
          controller.enqueue(new Uint8Array(0));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'content-type': 'application/x-tar' } },
    );
    await expect(
      writeDownloadStream(
        response,
        {
          async write() {},
          async close() {},
          async abort() {},
        },
        {
          timeoutMs: 30 * 60_000,
          minBytes: 1,
          maxBytes: 1024 ** 4,
          expectedType: 'application/x-tar',
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ kind: 'INVALID_RESPONSE' });
    expect(produced).toBeLessThanOrEqual(200003);
    expect(cancelled).toBe(true);
  });
});
