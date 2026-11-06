import { ApiError } from './http';

export interface DownloadSink {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}
export interface DownloadStreamOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  maxBytes: number;
  minBytes: number;
  expectedType: string;
  prefixBytes?: number;
  validatePrefix?: (prefix: Uint8Array) => void;
  onProgress?: (bytes: number) => void;
}
export function validStreamOptions(options: DownloadStreamOptions): boolean {
  return (
    Number.isSafeInteger(options.maxBytes) &&
    options.maxBytes >= 1 &&
    options.maxBytes <= 256 * 1024 * 1024 &&
    Number.isSafeInteger(options.minBytes) &&
    options.minBytes >= 1 &&
    options.minBytes <= options.maxBytes &&
    Number.isSafeInteger(options.timeoutMs) &&
    options.timeoutMs >= 1 &&
    options.timeoutMs <= 30 * 60_000 &&
    Number.isSafeInteger(options.prefixBytes ?? 0) &&
    (options.prefixBytes ?? 0) >= 0 &&
    (options.prefixBytes ?? 0) <= 4096 &&
    (options.prefixBytes ?? 0) <= options.minBytes &&
    /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(options.expectedType)
  );
}

/** Hold one bounded network chunk; wait for disk before reading the next one. */
export async function writeDownloadStream(
  response: Response,
  sink: DownloadSink,
  options: DownloadStreamOptions,
  signal: AbortSignal,
  deadline = performance.now() + options.timeoutMs,
): Promise<number> {
  if (
    response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !==
    options.expectedType
  )
    throw new ApiError('INVALID_RESPONSE', '下载文件类型与任务回执不符');
  const length = response.headers.get('content-length');
  if (
    length !== null &&
    (!/^\d+$/.test(length) ||
      !Number.isSafeInteger(Number(length)) ||
      Number(length) > options.maxBytes ||
      Number(length) < options.minBytes)
  )
    throw new ApiError('INVALID_RESPONSE', '下载文件声明大小与任务回执不符');
  if (!response.body) throw new ApiError('INVALID_RESPONSE', '下载文件为空');
  const reader = response.body.getReader();
  const prefixSize = options.prefixBytes ?? 0;
  const prefix = new Uint8Array(prefixSize);
  let prefixOffset = 0,
    prefixChecked = prefixSize === 0,
    bytes = 0,
    reads = 0;
  const check = () => {
    if (signal.aborted) throw signal.reason;
    if (performance.now() >= deadline)
      throw new ApiError('TIMEOUT', '下载超时');
  };
  const cancelReader = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener('abort', cancelReader, { once: true });
  try {
    for (;;) {
      check();
      const part = await reader.read();
      check();
      if (part.done) break;
      if (
        !ArrayBuffer.isView(part.value) ||
        Object.prototype.toString.call(part.value) !== '[object Uint8Array]' ||
        part.value.byteLength > 8 * 1024 * 1024 ||
        ++reads > 200_000 ||
        bytes + part.value.byteLength > options.maxBytes
      )
        throw new ApiError('INVALID_RESPONSE', '下载文件超过有界流大小限制');
      bytes += part.value.byteLength;
      if (!prefixChecked) {
        const count = Math.min(
          prefixSize - prefixOffset,
          part.value.byteLength,
        );
        prefix.set(part.value.subarray(0, count), prefixOffset);
        prefixOffset += count;
        if (prefixOffset === prefixSize) {
          options.validatePrefix?.(prefix);
          prefixChecked = true;
        }
      }
      await sink.write(part.value);
      check();
      options.onProgress?.(bytes);
    }
    if (
      !prefixChecked ||
      bytes < options.minBytes ||
      (length !== null && bytes !== Number(length))
    )
      throw new ApiError('INVALID_RESPONSE', '下载文件不完整');
    check();
    await sink.close();
    check();
    return bytes;
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', cancelReader);
    reader.releaseLock();
  }
}
