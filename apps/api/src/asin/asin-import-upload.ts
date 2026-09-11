import {
  ImportFileStore,
  ImportParseError,
  type ImportFileReference,
} from '@asin-monitor/import';
import type { FastifyRequest } from 'fastify';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/** Consume serial multipart parts completely before deciding useAsync; browsers
 * may send the mode after the file. The persistent file survives the response. */
export async function receiveImportFile(
  request: FastifyRequest,
  storage: ImportFileStore,
  taskId: string,
  signal: AbortSignal,
): Promise<{ file: ImportFileReference; useAsync: boolean }> {
  signal.throwIfAborted();
  if (!request.isMultipart())
    throw new ImportParseError('invalid', '请上传 XLSX 或 CSV 文件');
  let file: ImportFileReference | undefined;
  const modes: unknown[] = [];
  const abort = () => request.raw.destroy();
  signal.addEventListener('abort', abort, { once: true });
  const parts = request.parts();
  try {
    for await (const part of parts) {
      signal.throwIfAborted();
      if (part.type === 'field') {
        if (part.fieldnameTruncated || part.valueTruncated)
          throw new ImportParseError('capacity', '导入表单字段超过限制');
        if (part.fieldname === 'useAsync') modes.push(part.value);
        continue;
      }
      if (part.fieldname !== 'file' || file) {
        await pipeline(
          part.file,
          new Writable({
            write(_chunk, _encoding, callback) {
              callback();
            },
          }),
          { signal },
        );
        throw new ImportParseError('invalid', '请只上传一个 file 文件字段');
      }
      try {
        file = await storage.save(
          part.file,
          taskId,
          part.filename,
          part.mimetype,
          signal,
        );
      } catch (error) {
        if (
          part.file.destroyed &&
          !part.file.readableEnded &&
          !signal.aborted
        ) {
          // The multipart parser queues its limit/malformed-form error when it
          // destroys the yielded file. Surface that error instead of an I/O one.
          while (true) {
            signal.throwIfAborted();
            const pending = await parts.next();
            if (pending.done) break;
            if (pending.value.type === 'file') pending.value.file.destroy();
          }
        }
        // Validation can fail before save attaches to the file stream. Consume
        // that bounded stream so the multipart parser does not remain blocked.
        if (!part.file.destroyed)
          await pipeline(
            part.file,
            new Writable({
              write(_chunk, _encoding, callback) {
                callback();
              },
            }),
            { signal },
          );
        throw error;
      }
      if (part.file.truncated)
        throw new ImportParseError('capacity', '导入文件超过 10 MiB 限制');
    }
    signal.throwIfAborted();
    if (!file) throw new ImportParseError('invalid', '请选择要导入的文件');
    return {
      file,
      useAsync: !(
        modes.length === 1 &&
        (modes[0] === 'false' || modes[0] === false)
      ),
    };
  } catch (error) {
    if (file) await storage.remove(file);
    signal.throwIfAborted();
    if (error instanceof ImportParseError) throw error;
    const code = (error as { code?: unknown })?.code;
    if (
      typeof code === 'string' &&
      [
        'FST_REQ_FILE_TOO_LARGE',
        'FST_FILES_LIMIT',
        'FST_FIELDS_LIMIT',
        'FST_PARTS_LIMIT',
      ].includes(code)
    )
      throw new ImportParseError('capacity', '导入表单或文件超过限制');
    if (typeof code === 'string' && code.startsWith('FST_'))
      throw new ImportParseError('invalid', '导入表单无效');
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
