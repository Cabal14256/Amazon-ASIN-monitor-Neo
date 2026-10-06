import type { DownloadSink } from './download-stream';
import { ApiError } from './http';

export const FILE_SAVE_BLOB_MAX_BYTES = 32 * 1024 * 1024;
const FILE_SAVE_CAPACITY = 64;
const FILE_SAVE_TIMEOUT_MS = 30 * 60_000;
let physicalFileSaves = 0;
export interface FileSaveHandle {
  createWritable(): Promise<DownloadSink>;
}
export type FileSavePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileSaveHandle>;
export type FileSaveDestination =
  | { kind: 'file'; filename: string; handle: FileSaveHandle }
  | { kind: 'blob'; filename: string };

function picker(): FileSavePicker | undefined {
  if (typeof window === 'undefined') return undefined;
  const browser = window as unknown as {
    isSecureContext?: boolean;
    showSaveFilePicker?: FileSavePicker;
  };
  return browser.isSecureContext &&
    typeof browser.showSaveFilePicker === 'function'
    ? browser.showSaveFilePicker.bind(window)
    : undefined;
}

/** Invoke from the click gesture; intentionally not async or preceded by GET. */
export function chooseFileSave(
  filename: string,
  bytes: number,
  mimeType: string,
  extension: string,
  savePicker = picker(),
): Promise<FileSaveDestination> {
  if (
    !filename ||
    filename.length > 200 ||
    /[/\\]/.test(filename) ||
    [...filename].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    }) ||
    !Number.isSafeInteger(bytes) ||
    bytes < 1 ||
    bytes > 256 * 1024 * 1024
  )
    throw new ApiError('INVALID_INPUT', '保存文件标识或大小无效');
  if (savePicker)
    return savePicker({
      suggestedName: filename,
      types: [{ description: '导出文件', accept: { [mimeType]: [extension] } }],
    }).then((handle) => ({ kind: 'file', filename, handle }));
  if (bytes > FILE_SAVE_BLOB_MAX_BYTES)
    throw new ApiError(
      'INVALID_INPUT',
      '此文件超过 32 MiB 内存下载上限。请在 HTTPS 或本机可信地址，用支持“选择保存位置”的 Chrome / Edge 浏览器保存；也可缩小导出范围后重试。',
    );
  return Promise.resolve({ kind: 'blob', filename });
}

export async function saveToFile(
  handle: FileSaveHandle,
  signal: AbortSignal,
  current: () => boolean,
  transfer: (sink: DownloadSink, signal: AbortSignal) => Promise<number>,
): Promise<number> {
  if (signal.aborted || !current())
    throw new ApiError('CANCELLED', '下载已取消');
  if (physicalFileSaves >= FILE_SAVE_CAPACITY)
    throw new ApiError(
      'CAPACITY',
      '文件保存并发过多，请等待现有文件操作结束后重试',
    );
  // Reserve before opening a writable: an HTTP capacity rejection must not
  // create another native file/abort outside the existing transport budget.
  physicalFileSaves++;
  const controller = new AbortController();
  let pendingNative = 0,
    logicalSettled = false,
    released = false,
    sink: DownloadSink | undefined,
    aborting: Promise<void> | undefined,
    physicallyClosed = false;
  const release = () => {
    if (!released && logicalSettled && pendingNative === 0) {
      released = true;
      physicalFileSaves--;
    }
  };
  const native = <T>(operation: () => Promise<T>): Promise<T> => {
    pendingNative++;
    // Account before calling native code; the microtask also assigns any
    // abortOnce promise before a synchronous throw/reentrant callback can run.
    return Promise.resolve()
      .then(operation)
      .finally(() => {
        pendingNative--;
        release();
      });
  };
  const check = () => {
    if (controller.signal.aborted) throw controller.signal.reason;
    if (!current()) throw new ApiError('CANCELLED', '下载已取消');
  };
  const abortOnce = (reason: unknown) =>
    (aborting ??=
      physicallyClosed || !sink
        ? Promise.resolve()
        : native(() => sink!.abort(reason)).catch(() => undefined));
  const abort = () => controller.abort(new ApiError('CANCELLED', '下载已取消'));
  const onAbort = () => {
    if (sink) void abortOnce(controller.signal.reason);
  };
  signal.addEventListener('abort', abort, { once: true });
  controller.signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) abort();
  const timer = setTimeout(
    () => controller.abort(new ApiError('TIMEOUT', '下载超时')),
    FILE_SAVE_TIMEOUT_MS,
  );
  const work = (async () => {
    sink = await native(() => {
      check();
      return handle.createWritable();
    });
    check();
    const guarded: DownloadSink = {
      async write(chunk) {
        check();
        await native(() => {
          check();
          return sink!.write(chunk);
        });
        check();
      },
      async close() {
        check();
        await native(async () => {
          check();
          await sink!.close();
          // Physical commit cannot be undone by a later scope change.
          physicallyClosed = true;
        });
        check();
      },
      async abort(reason) {
        await abortOnce(reason);
      },
    };
    const bytes = await transfer(guarded, controller.signal);
    check();
    return bytes;
  })()
    .catch((error: unknown) => {
      const failure = controller.signal.aborted
        ? controller.signal.reason
        : error;
      if (sink) void abortOnce(failure);
      if (!controller.signal.aborted) controller.abort(failure);
      throw failure;
    })
    .finally(() => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', onAbort);
      logicalSettled = true;
      release();
    });
  // Prompt cancellation/deadline is independent of a hung open/write/close or
  // abort; native promises retain their own physical reservation until settled.
  return new Promise<number>((resolve, reject) => {
    const cancelled = () => reject(controller.signal.reason);
    if (controller.signal.aborted) cancelled();
    else controller.signal.addEventListener('abort', cancelled, { once: true });
    work
      .then(resolve, reject)
      .finally(() => controller.signal.removeEventListener('abort', cancelled));
  });
}
