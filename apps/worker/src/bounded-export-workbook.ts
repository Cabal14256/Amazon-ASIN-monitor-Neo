import ExcelJS from 'exceljs';
import { once } from 'node:events';
import { PassThrough, type Readable, type Writable } from 'node:stream';

const WORKSHEET_HIGH_WATER_MARK = 64 * 1024;
class WorksheetStream extends PassThrough {
  override write(
    chunk: unknown,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    // ExcelJS headers use its reusable StringBuf. toBuffer() returns an owned
    // copy, so later reset/addText cannot corrupt a queued native write.
    const value =
      chunk &&
      typeof chunk === 'object' &&
      typeof (chunk as { toBuffer?: unknown }).toBuffer === 'function'
        ? (chunk as { toBuffer(): Buffer }).toBuffer()
        : chunk;
    if (typeof value !== 'string' && !Buffer.isBuffer(value))
      throw new Error('EXPORT_WORKSHEET_CHUNK_INVALID');
    return typeof encoding === 'string'
      ? super.write(value, encoding, callback)
      : super.write(value, encoding ?? callback);
  }
}
interface WorkbookInternals {
  zip: Writable & {
    append(source: Readable, options: { name: string }): unknown;
    abort(): void;
  };
  _openStream(path: string): PassThrough;
}

/** ExcelJS 4.4.0's default StreamBuf ignores batch backpressure. Adapt only
 * its worksheet stream factory; native streams expose a real drain boundary. */
export function createBoundedExportWorkbook(
  output: Writable,
  onFailure: (error: Error) => void,
) {
  const zipOptions = {
    highWaterMark: WORKSHEET_HIGH_WATER_MARK,
    zlib: { level: 6 },
  };
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: output,
    useSharedStrings: false,
    useStyles: false,
    zip: zipOptions,
  });
  const internals = workbook as unknown as WorkbookInternals;
  if (
    !internals.zip ||
    typeof internals.zip.append !== 'function' ||
    typeof internals.zip.abort !== 'function'
  )
    throw new Error('EXPORT_WORKBOOK_STREAM_ADAPTER_UNAVAILABLE');
  const streams: PassThrough[] = [];
  let stopped = false;
  internals.zip.on('error', onFailure);
  internals._openStream = (path) => {
    if (stopped) throw new Error('EXPORT_WORKBOOK_STOPPED');
    const stream = new WorksheetStream({
      highWaterMark: WORKSHEET_HIGH_WATER_MARK,
    });
    // Observe errors even when a header/footer is written outside drain().
    stream.on('error', onFailure);
    stream.once('close', () => {
      if (!stopped && !stream.writableFinished)
        onFailure(new Error('EXPORT_WORKSHEET_CLOSED'));
    });
    streams.push(stream);
    internals.zip.append(stream, { name: path });
    stream.once('finish', () => stream.emit('zipped'));
    return stream;
  };
  return {
    workbook,
    async drain(signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      if (stopped) throw new Error('EXPORT_WORKBOOK_STOPPED');
      for (const stream of streams) {
        if (stream.errored) throw stream.errored;
        if (stream.destroyed && !stream.writableFinished)
          throw new Error('EXPORT_WORKSHEET_CLOSED');
        if (stream.writableNeedDrain) {
          await once(stream, 'drain', { signal });
          signal.throwIfAborted();
        }
      }
    },
    stop(error?: Error) {
      if (stopped) return;
      stopped = true;
      internals.zip.abort();
      for (const stream of streams) stream.destroy(error);
      internals.zip.destroy(error);
    },
    get worksheetBufferedBytes() {
      return streams.reduce(
        (total, stream) =>
          total + stream.writableLength + stream.readableLength,
        0,
      );
    },
  };
}
