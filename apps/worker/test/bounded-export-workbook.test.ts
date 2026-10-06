import ExcelJS from 'exceljs';
import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createBoundedExportWorkbook } from '../src/bounded-export-workbook';

describe('actual ExcelJS worksheet backpressure', () => {
  it('blocks wide-row production on a stalled output and releases every internal entry on cancellation', async () => {
    const controller = new AbortController();
    const output = new Writable({ write(_chunk, _encoding, _callback) {} });
    output.on('error', () => undefined);
    const writer = createBoundedExportWorkbook(output, (error) =>
      controller.abort(error),
    );
    const sheet = writer.workbook.addWorksheet('slow-output');
    let written = 0;
    const writing = (async () => {
      for (let index = 0; index < 5000; index++) {
        // Distinct high-entropy rows also fill the compressed output budget;
        // repeating one string would test compression, not a stalled sink.
        const wide = randomBytes(8192).toString('hex');
        sheet.addRow([String(index), wide, wide]).commit();
        written++;
        await writer.drain(controller.signal);
      }
    })();
    // Observe the rejection immediately, while keeping the sink stalled.
    const outcome = writing.then(
      () => 'completed',
      () => 'stopped',
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const atPause = written;
      expect(atPause).toBeGreaterThan(0);
      expect(atPause).toBeLessThan(300);
      expect(writer.worksheetBufferedBytes).toBeLessThan(256 * 1024);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(written).toBe(atPause);
    } finally {
      controller.abort(new Error('fixture cancellation'));
      writer.stop(controller.signal.reason);
      output.destroy();
    }
    expect(await outcome).toBe('stopped');
  });

  it('writes an actual XLSX with literal wide cells after a slow sink resumes', async () => {
    const controller = new AbortController();
    const chunks: Buffer[] = [];
    const output = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        setTimeout(callback, 1);
      },
    });
    const writer = createBoundedExportWorkbook(output, (error) =>
      controller.abort(error),
    );
    const sheet = writer.workbook.addWorksheet('literal');
    const value = '=1+1 ' + randomBytes(8192).toString('hex');
    for (let index = 0; index < 40; index++) {
      sheet.addRow([String(index), value]).commit();
      await writer.drain(controller.signal);
    }
    await writer.workbook.commit();
    const book = new ExcelJS.Workbook();
    const bytes = Buffer.concat(chunks);
    await book.xlsx.load(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    );
    const actual = book.getWorksheet('literal')!;
    expect(actual.rowCount).toBe(40);
    expect(actual.getRow(1).getCell(2).value).toBe(value);
    expect(actual.getRow(40).getCell(1).value).toBe('39');
  }, 15_000);
});
