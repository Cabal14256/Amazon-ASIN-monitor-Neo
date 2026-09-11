import { ImportFileStore, ImportParseError } from '@asin-monitor/import';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { receiveImportFile } from '../src/asin/asin-import-upload';

const fixtures: { app: FastifyInstance; storage: ImportFileStore }[] = [];
async function fixture() {
  const app = Fastify();
  const storage = new ImportFileStore(
    await mkdtemp(join(tmpdir(), 'neo-http-import-')),
  );
  fixtures.push({ app, storage });
  await app.register(multipart, {
    limits: {
      files: 1,
      fileSize: 10 * 1024 * 1024,
      fields: 16,
      parts: 17,
      fieldNameSize: 100,
      fieldSize: 1024,
    },
  });
  app.post('/upload', async (request, reply) => {
    try {
      return await receiveImportFile(
        request,
        storage,
        randomUUID(),
        AbortSignal.timeout(2000),
      );
    } catch (error) {
      return reply
        .status(
          error instanceof ImportParseError
            ? error.code === 'capacity'
              ? 413
              : 400
            : 500,
        )
        .send({
          message:
            error instanceof ImportParseError ? error.message : 'upload failed',
        });
    }
  });
  await app.ready();
  return { app, storage };
}
afterEach(async () => {
  for (const { app, storage } of fixtures.splice(0)) {
    await app.close();
    await storage.close();
    await rm(storage.directory, { recursive: true, force: true });
  }
});
type Part = { name: string; text: string; filename?: string; mime?: string };
function form(parts: Part[]) {
  const boundary = 'import-fixture-boundary';
  const text =
    parts
      .map(
        (part) =>
          `--${boundary}\r\nContent-Disposition: form-data; name="${
            part.name
          }"${part.filename ? `; filename="${part.filename}"` : ''}\r\n${
            part.mime ? `Content-Type: ${part.mime}\r\n` : ''
          }\r\n${part.text}\r\n`,
      )
      .join('') + `--${boundary}--\r\n`;
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: text,
  };
}
const file: Part = {
  name: 'file',
  text: 'group,country,site,brand,asin,type\nA,US,S,B,B000000001,1',
  filename: 'fixture.csv',
  mime: 'text/csv',
};

describe('actual streaming multipart import upload', () => {
  it.each([true, false])(
    'reads useAsync=false when it appears before the file=%s',
    async (before) => {
      const { app, storage } = await fixture();
      const mode: Part = { name: 'useAsync', text: 'false' };
      const response = await app.inject({
        method: 'POST',
        url: '/upload',
        ...form(before ? [mode, file] : [file, mode]),
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().useAsync).toBe(false);
      expect(await readdir(storage.directory)).toHaveLength(1);
      await storage.verifiedPath(
        response.json().file,
        AbortSignal.timeout(2000),
      );
    },
  );
  it.each(
    [[], ['true'], ['False'], ['0'], [' false '], ['false', 'false']].map(
      (modes) => ({ modes }),
    ),
  )('keeps Legacy default async for $modes', async ({ modes }) => {
    const { app } = await fixture();
    const response = await app.inject({
      method: 'POST',
      url: '/upload',
      ...form([file, ...modes.map((text) => ({ name: 'useAsync', text }))]),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().useAsync).toBe(true);
  });
  it.each(
    [
      [{ ...file, name: 'wrong-field' }],
      [{ ...file, filename: 'fixture.exe' }],
      [{ ...file, mime: 'text/plain' }],
      [],
    ].map((parts) => ({ parts })),
  )(
    'rejects invalid file form without retaining uploads: $parts',
    async ({ parts }) => {
      const { app, storage } = await fixture();
      const response = await app.inject({
        method: 'POST',
        url: '/upload',
        ...form(parts),
      });
      expect(response.statusCode).toBe(400);
      expect(await readdir(storage.directory)).toEqual([]);
    },
  );
  it('rejects extra files and cleans an already-persisted first file', async () => {
    const { app, storage } = await fixture();
    const response = await app.inject({
      method: 'POST',
      url: '/upload',
      ...form([file, file]),
    });
    expect(response.statusCode).toBe(413);
    expect(await readdir(storage.directory)).toEqual([]);
  });
  it('surfaces a queued multipart limit after intermediate fields without waiting for timeout', async () => {
    const { app, storage } = await fixture();
    const fields = Array.from({ length: 5 }, (_, index) => ({
      name: `field${index}`,
      text: 'value',
    }));
    const response = await app.inject({
      method: 'POST',
      url: '/upload',
      ...form([file, ...fields, file]),
    });
    expect(response.statusCode).toBe(413);
    expect(await readdir(storage.directory)).toEqual([]);
  });
  it('rejects too many fields while an early file is waiting to be written', async () => {
    const { app, storage } = await fixture();
    const fields = Array.from({ length: 17 }, (_, index) => ({
      name: `field${index}`,
      text: 'value',
    }));
    const response = await app.inject({
      method: 'POST',
      url: '/upload',
      ...form([file, ...fields]),
    });
    expect(response.statusCode).toBe(413);
    expect(await readdir(storage.directory)).toEqual([]);
  });
  it('rejects a truncated 10 MiB upload and deletes its published prefix', async () => {
    const { app, storage } = await fixture();
    const response = await app.inject({
      method: 'POST',
      url: '/upload',
      ...form([{ ...file, text: 'x'.repeat(10 * 1024 * 1024 + 1) }]),
    });
    expect(response.statusCode).toBe(413);
    expect(await readdir(storage.directory)).toEqual([]);
  });
  it('rejects an oversized late mode field and cleans the file', async () => {
    const { app, storage } = await fixture();
    const response = await app.inject({
      method: 'POST',
      url: '/upload',
      ...form([file, { name: 'useAsync', text: 'x'.repeat(1025) }]),
    });
    expect(response.statusCode).toBe(413);
    expect(await readdir(storage.directory)).toEqual([]);
  });
});
