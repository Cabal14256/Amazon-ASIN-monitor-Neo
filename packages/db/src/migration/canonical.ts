import { createHash } from 'node:crypto';

import { DataMigrationError } from './errors';
import type { TableMigrationSpec } from './registry';

export type MigrationRow = Record<string, unknown>;

function normalizeCanonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (Array.isArray(value)) return value.map(normalizeCanonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalizeCanonical(entry)]),
    );
  }
  if (value === undefined) return null;
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeCanonical(value));
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function booleanValue(
  value: unknown,
  table: string,
  column: string,
): boolean | null {
  if (value === null || value === undefined) return null;
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  throw new DataMigrationError(
    'SOURCE_BOOLEAN_INVALID',
    `${table}.${column}`,
    `source boolean value is invalid for ${table}.${column}`,
  );
}

function jsonValue(
  value: unknown,
  table: string,
  column: string,
  rowKeyHash: string,
): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') return value;
  if (!value.trim()) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new DataMigrationError(
      'SOURCE_JSON_INVALID',
      `${table}.${column}`,
      `source JSON is invalid for ${table}.${column} at row hash ${rowKeyHash}`,
    );
  }
}

export function transformSourceRow(
  spec: TableMigrationSpec,
  sourceRow: MigrationRow,
): MigrationRow {
  const rowKeyHash = sha256(
    spec.primaryKeyColumns.map((column) => sourceRow[column]),
  );
  return Object.fromEntries(
    spec.columns.map((column) => {
      const value = sourceRow[column];
      if (spec.booleanColumns.has(column)) {
        return [column, booleanValue(value, spec.name, column)];
      }
      if (spec.jsonColumns.has(column)) {
        return [column, jsonValue(value, spec.name, column, rowKeyHash)];
      }
      return [column, value ?? null];
    }),
  );
}

interface SampleEntry {
  readonly rank: string;
  readonly keyValues: readonly unknown[];
  readonly row: MigrationRow;
}

export class DeterministicSampler {
  private readonly entries: SampleEntry[] = [];

  constructor(
    private readonly tableName: string,
    private readonly maximumSize: number,
  ) {}

  add(keyValues: readonly unknown[], row: MigrationRow): void {
    if (this.maximumSize === 0) return;
    const entry = {
      rank: sha256([this.tableName, keyValues]),
      keyValues: [...keyValues],
      row,
    };
    this.entries.push(entry);
    this.entries.sort((left, right) => left.rank.localeCompare(right.rank));
    if (this.entries.length > this.maximumSize) this.entries.pop();
  }

  samples(): readonly SampleEntry[] {
    return this.entries;
  }

  digest(columns: readonly string[]): string | null {
    if (this.entries.length === 0) return null;
    return sha256(
      this.entries.map(({ row }) => columns.map((column) => row[column])),
    );
  }
}
