import { describe, expect, it } from 'vitest';
import {
  backupCanonicalTableNameSchema,
  backupQualifiedTableName,
  createBackupRequestSchema,
  parseBackupTableIdentifiers,
} from '../src/domains/backup';

describe('internal canonical backup table identity', () => {
  it.each([
    ['public.OrderItems', ['public', 'OrderItems']],
    ['Simple', ['Simple']],
    ['"schema.dot"."quote""Table"', ['schema.dot', 'quote"Table']],
    ['"schema space"."name;literal"', ['schema space', 'name;literal']],
  ])('parses %s as exact literal identifiers', (input, parts) => {
    expect(parseBackupTableIdentifiers(String(input))).toEqual(parts);
    expect(backupCanonicalTableNameSchema.safeParse(input).success).toBe(true);
  });
  it('formats quoted catalog names without splitting their embedded dots or quotes', () => {
    expect(backupQualifiedTableName('schema.dot"quoted', 'table')).toBe(
      '"schema.dot""quoted"."table"',
    );
    expect(backupQualifiedTableName('MixedSchema', 'MixedTable')).toBe(
      'MixedSchema.MixedTable',
    );
  });
  it.each([
    '',
    'a..b',
    'a.b.c',
    'a.',
    '"unclosed',
    '"".t',
    'a b',
    't;drop',
    '"control\n".t',
  ])('refuses malformed internal identity %j', (input) => {
    expect(backupCanonicalTableNameSchema.safeParse(input).success).toBe(false);
  });
  it('preserves the frozen public request grammar', () => {
    expect(
      createBackupRequestSchema.safeParse({ tables: ['public.OrderItems'] })
        .success,
    ).toBe(true);
    expect(
      createBackupRequestSchema.safeParse({ tables: ['"schema.dot"."orders"'] })
        .success,
    ).toBe(false);
  });
});
