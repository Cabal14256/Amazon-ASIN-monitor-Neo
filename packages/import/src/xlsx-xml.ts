import ExcelJS from 'exceljs';
import { addAbortSignal } from 'node:stream';
import { finished } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import { SaxesParser, type SaxesTagPlain } from 'saxes';
import type { Entry, ZipFile } from 'yauzl';
import { ImportParseError } from './rows';

export interface XmlHandler {
  parseOpen(node: SaxesTagPlain): unknown;
  parseText(text: string): unknown;
  parseClose(name: string): unknown;
}
export interface Xform<T> extends XmlHandler {
  model: T;
}
type Constructor<T> = new (...args: unknown[]) => T;

// Pin ExcelJS 4.4.0 and keep its document cell decoder in one adapter. Its
// public streaming reader has different formula/inline-string/merge behavior.
// Whole-file comparison fixtures guard this dependency on the pinned internals.
export const WorkbookXform =
  require('exceljs/lib/xlsx/xform/book/workbook-xform') as Constructor<
    Xform<{
      sheets: { rId: string; id: number }[];
      properties: { date1904?: boolean };
    }>
  >;
export const RelationshipsXform =
  require('exceljs/lib/xlsx/xform/core/relationships-xform') as Constructor<
    Xform<
      {
        Id: string;
        Type: string;
        Target: string;
        TargetMode?: string;
      }[]
    >
  >;
export const SharedStringsXform =
  require('exceljs/lib/xlsx/xform/strings/shared-strings-xform') as Constructor<
    Xform<{
      values: ExcelJS.CellValue[];
      count: number;
    }> & { getString(index: number): ExcelJS.CellValue }
  >;
export const StylesXform =
  require('exceljs/lib/xlsx/xform/style/styles-xform') as Constructor<
    Xform<unknown> & {
      getStyleModel(index: number): Partial<ExcelJS.Style>;
    }
  >;
export const RowXform =
  require('exceljs/lib/xlsx/xform/sheet/row-xform') as Constructor<
    Xform<ExcelJS.RowModel> & {
      reconcile(
        model: ExcelJS.RowModel,
        options: Record<string, unknown>,
      ): void;
    }
  >;
export const ExcelRow = require('exceljs/lib/doc/row') as new (
  sheet: ExcelJS.Worksheet,
  number: number,
) => ExcelJS.Row;

/** Streams only this ZIP member. SAX, decoded bytes and descriptors all have
 * the same cancellation boundary; no extraction or temporary files are used. */
export async function readXml(
  zip: ZipFile,
  entry: Entry,
  maxBytes: number,
  signal: AbortSignal,
  handler: XmlHandler,
) {
  signal.throwIfAborted();
  if (entry.uncompressedSize > maxBytes)
    throw new ImportParseError('capacity', 'XLSX 解压内容超过限制');
  const stream = await zip.openReadStreamPromise(entry);
  const completion = finished(stream).catch(() => undefined);
  addAbortSignal(signal, stream);
  const parser = new SaxesParser({ xmlns: false });
  parser.on('opentag', (node) => handler.parseOpen(node));
  parser.on('text', (text) => handler.parseText(text));
  parser.on('cdata', (text) => handler.parseText(text));
  parser.on('closetag', (node) => handler.parseClose(node.name));
  parser.on('doctype', () => {
    throw new ImportParseError('invalid', 'XLSX 包含不支持的文档类型声明');
  });
  parser.on('error', () => {
    throw new ImportParseError('invalid', 'XLSX XML 内容无效');
  });
  const decoder = new StringDecoder('utf8');
  let bytes = 0;
  try {
    for await (const chunk of stream) {
      signal.throwIfAborted();
      bytes += (chunk as Buffer).length;
      if (bytes > maxBytes)
        throw new ImportParseError('capacity', 'XLSX 解压内容超过限制');
      parser.write(decoder.write(chunk as Buffer));
    }
    parser.write(decoder.end()).close();
    signal.throwIfAborted();
  } finally {
    stream.destroy();
    await completion;
  }
}
