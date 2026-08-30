import { createHash } from 'node:crypto';

import {
  isLosslessNumber,
  LosslessNumber,
  parse as parseLosslessJson,
  stringify as stringifyLosslessJson,
} from 'lossless-json';

import { DataMigrationError } from './errors';
import type { TableMigrationSpec } from './registry';

export type MigrationRow = Record<string, unknown>;

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalNumberLexeme(value: string): string {
  const match = /^(-?)(0|[1-9]\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(value);
  if (!match)
    throw new Error('lossless JSON parser returned an invalid number');
  const [, sign, integer, fraction = '', explicitExponent = '0'] = match;
  let digits = `${integer}${fraction}`.replace(/^0+/, '');
  if (!digits) return '0';
  let exponent = BigInt(explicitExponent) - BigInt(fraction.length);
  while (digits.endsWith('0')) {
    digits = digits.slice(0, -1);
    exponent += 1n;
  }
  return `${sign}${digits}e${exponent.toString()}`;
}

export class MigrationJsonDocument {
  constructor(public readonly value: unknown) {}

  toPostgres(): string {
    return canonicalJson(this.value);
  }
}

export function parseMigrationJsonDocument(
  value: string,
): MigrationJsonDocument {
  return new MigrationJsonDocument(parseLosslessJson(value));
}

export function migrationJsonText(value: unknown): string {
  if (!(value instanceof MigrationJsonDocument)) {
    throw new Error('value is not a migration JSON document');
  }
  return value.toPostgres();
}

function normalizeCanonical(value: unknown): unknown {
  if (value instanceof MigrationJsonDocument) {
    return normalizeCanonical(value.value);
  }
  if (isLosslessNumber(value)) {
    return new LosslessNumber(canonicalNumberLexeme(value.toString()));
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (Array.isArray(value)) return value.map(normalizeCanonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([key, entry]) => [key, normalizeCanonical(entry)]),
    );
  }
  if (value === undefined) return null;
  return value;
}

export function canonicalJson(value: unknown): string {
  return stringifyLosslessJson(normalizeCanonical(value)) ?? 'null';
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function canonicalMultisetDigest(values: readonly unknown[]): string {
  const canonicalValues = values.map(canonicalJson).sort(compareCodeUnits);
  return sha256(canonicalValues);
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
  if (value instanceof MigrationJsonDocument) return value;
  if (typeof value !== 'string') {
    throw new DataMigrationError(
      'SOURCE_JSON_INVALID',
      `${table}.${column}`,
      `source JSON value has an unsupported representation in ${table}.${column} at row hash ${rowKeyHash}`,
    );
  }
  if (!value.trim()) return null;
  try {
    return parseMigrationJsonDocument(value);
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
    this.entries.sort((left, right) => compareCodeUnits(left.rank, right.rank));
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
