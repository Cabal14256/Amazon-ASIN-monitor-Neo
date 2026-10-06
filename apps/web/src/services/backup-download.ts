import type { DownloadSink } from '../lib/download-stream';
import { ApiError, type HttpClient } from '../lib/http';
import type { BackupApi } from './backup';
import {
  BACKUP_BLOB_MAX_BYTES,
  BACKUP_TRANSFER_TIMEOUT_MS,
  backupArchiveMaxBytes,
  backupFilenameTarget,
  type BackupFile,
} from './backup-model';

export interface BackupSaveHandle {
  createWritable(): Promise<DownloadSink>;
}
export type BackupSavePicker = (options: {
  suggestedName: string;
  types: { description: string; accept: Record<string, string[]> }[];
}) => Promise<BackupSaveHandle>;
export type BackupDownloadDestination =
  | { kind: 'file'; handle: BackupSaveHandle; filename: string }
  | { kind: 'blob'; filename: string };

export function backupSavePicker(): BackupSavePicker | undefined {
  const browser = window as unknown as {
    isSecureContext?: boolean;
    showSaveFilePicker?: BackupSavePicker;
  };
  return browser.isSecureContext &&
    typeof browser.showSaveFilePicker === 'function'
    ? browser.showSaveFilePicker.bind(window)
    : undefined;
}

/** Call directly inside the click handler, before any await or network work. */
export function chooseBackupDestination(
  file: BackupFile,
  picker = backupSavePicker(),
): Promise<BackupDownloadDestination> {
  backupFilenameTarget(file.filename);
  const filename = file.filename.replace(/\.dump$/, '.tar');
  if (picker)
    return picker({
      suggestedName: filename,
      types: [
        {
          description: 'PostgreSQL 备份与元数据归档',
          accept: { 'application/x-tar': ['.tar'] },
        },
      ],
    }).then((handle) => ({ kind: 'file', handle, filename }));
  if (backupArchiveMaxBytes(file) > BACKUP_BLOB_MAX_BYTES)
    throw new ApiError(
      'INVALID_INPUT',
      '此归档超过内存下载上限。请在 HTTPS 或本机可信地址，用支持“选择保存位置”的 Chrome / Edge 浏览器保存大备份；也可联系运维从备份卷获取包含元数据的归档。',
    );
  return Promise.resolve({ kind: 'blob', filename });
}

function tarSize(bytes: Uint8Array): number {
  const field = bytes.subarray(124, 136);
  if (field[0] & 0x80) {
    let value = BigInt(field[0] & 0x7f);
    for (const byte of field.subarray(1)) value = value * 256n + BigInt(byte);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('tar size');
    return Number(value);
  }
  const text = new TextDecoder('ascii')
    .decode(field)
    .replace(/\0.*$/, '')
    .trim();
  if (!/^[0-7]+$/.test(text)) throw new Error('tar size');
  return parseInt(text, 8);
}

/** Bind the actual first tar entry to the selected immutable artifact and size. */
export function validateBackupTarPrefix(
  bytes: Uint8Array,
  file: BackupFile,
): void {
  try {
    if (bytes.byteLength !== 512) throw new Error('tar header');
    const name = new TextDecoder('ascii')
      .decode(bytes.subarray(0, 100))
      .replace(/\0.*$/, '');
    const checksumText = new TextDecoder('ascii')
      .decode(bytes.subarray(148, 156))
      .replace(/\0.*$/, '')
      .trim();
    if (!/^[0-7]+$/.test(checksumText)) throw new Error('tar checksum');
    const checksum = bytes.reduce(
      (sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte),
      0,
    );
    if (
      name !== file.filename ||
      tarSize(bytes) !== file.size ||
      checksum !== parseInt(checksumText, 8) ||
      (bytes[156] !== 48 && bytes[156] !== 0)
    )
      throw new Error('tar identity');
  } catch {
    throw new ApiError(
      'INVALID_RESPONSE',
      '下载归档与选中的备份不一致，请刷新列表核实',
    );
  }
}

export function saveBackupBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function downloadBackup(
  http: Pick<HttpClient, 'downloadTo'>,
  api: Pick<BackupApi, 'downloadPath'>,
  file: BackupFile,
  destination: BackupDownloadDestination,
  signal: AbortSignal,
  current: () => boolean,
  progress: (bytes: number) => void,
  saveBlob = saveBackupBlob,
): Promise<number> {
  const filename = file.filename.replace(/\.dump$/, '.tar');
  if (destination.filename !== filename)
    throw new ApiError('INVALID_INPUT', '保存位置与当前备份不一致');
  const check = () => {
    if (signal.aborted || !current())
      throw new ApiError('CANCELLED', '下载已取消');
  };
  check();
  let sink: DownloadSink;
  if (destination.kind === 'file') {
    sink = await destination.handle.createWritable();
    try {
      check();
    } catch (error) {
      await sink.abort(error).catch(() => undefined);
      throw error;
    }
  } else {
    if (backupArchiveMaxBytes(file) > BACKUP_BLOB_MAX_BYTES)
      throw new ApiError(
        'INVALID_INPUT',
        '此备份需要直接写入文件，不能使用内存回退',
      );
    let parts: Uint8Array[] = [],
      bytes = 0;
    sink = {
      async write(chunk) {
        check();
        bytes += chunk.byteLength;
        if (bytes > BACKUP_BLOB_MAX_BYTES)
          throw new ApiError('INVALID_RESPONSE', '归档超过内存下载上限');
        parts.push(chunk.slice());
      },
      async close() {
        check();
        saveBlob(new Blob(parts, { type: 'application/x-tar' }), filename);
        parts = [];
      },
      async abort() {
        parts = [];
      },
    };
  }
  try {
    const bytes = await http.downloadTo(api.downloadPath(file.filename), sink, {
      signal,
      timeoutMs: BACKUP_TRANSFER_TIMEOUT_MS,
      maxBytes: backupArchiveMaxBytes(file),
      minBytes: Math.ceil(file.size / 512) * 512 + 2048,
      expectedType: 'application/x-tar',
      prefixBytes: 512,
      validatePrefix: (prefix) => validateBackupTarPrefix(prefix, file),
      onProgress: (bytes) => {
        if (current() && !signal.aborted) progress(bytes);
      },
    });
    check();
    return bytes;
  } catch (error) {
    await sink.abort(error).catch(() => undefined);
    throw error;
  }
}
