import type { DownloadSink } from './download-stream';
import { ApiError } from './http';

export const FILE_SAVE_BLOB_MAX_BYTES = 32 * 1024 * 1024;
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
  transfer: (sink: DownloadSink) => Promise<number>,
): Promise<number> {
  const check = () => {
    if (signal.aborted || !current())
      throw new ApiError('CANCELLED', '下载已取消');
  };
  check();
  const sink = await handle.createWritable();
  let aborting: Promise<void> | undefined;
  const abortOnce = (reason: unknown) =>
    (aborting ??= sink.abort(reason).catch(() => undefined));
  try {
    check();
    const guarded: DownloadSink = {
      async write(chunk) {
        check();
        await sink.write(chunk);
        check();
      },
      async close() {
        check();
        await sink.close();
        check();
      },
      async abort(reason) {
        await abortOnce(reason);
      },
    };
    const bytes = await transfer(guarded);
    check();
    return bytes;
  } catch (error) {
    // Failed/cancelled transfers must settle even if the disk ignores abort.
    void abortOnce(error);
    throw error;
  }
}
