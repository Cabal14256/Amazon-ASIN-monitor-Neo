import { describe, expect, it } from 'vitest';
import {
  backupSelectiveRestoreQuery,
  backupTableSelectionQuery,
  resolveBackupTableSelection,
  selectiveBackupRestoreBlocked,
} from '../src/domain/backup-selective-restore';

describe('selective backup restore catalog boundary', () => {
  it('resolves exact catalog identities with a bounded parameterized application-session probe', () => {
    const input = ['OrderItems', '"schema.dot"."quote""Table"'];
    const query = backupTableSelectionQuery(input);
    expect(query.values).toEqual([
      ['"OrderItems"', '"schema.dot"."quote""Table"'],
    ]);
    expect(query.query_timeout).toBe(1500);
    expect(query.text).not.toContain('OrderItems');
    expect(query.text).toContain('pg_catalog.to_regclass');
    expect(
      resolveBackupTableSelection(input, [
        {
          schema: 'application',
          name: 'OrderItems',
          kind: 'r',
          persistence: 'p',
        },
        {
          schema: 'schema.dot',
          name: 'quote"Table',
          kind: 'p',
          persistence: 'p',
        },
      ]),
    ).toEqual(['application.OrderItems', '"schema.dot"."quote""Table"']);
    const restore = backupSelectiveRestoreQuery([
      '"schema.dot"."quote""Table"',
    ]);
    expect(restore.values).toEqual([['quote"Table'], ['schema.dot']]);
  });
  it.each([
    { schema: null, name: null, kind: null, persistence: null },
    { schema: 'application', name: 'Wrong', kind: 'r', persistence: 'p' },
    { schema: 'application', name: 'OrderItems', kind: 'r', persistence: 't' },
  ])('refuses a missing, truncated or temporary selection %j', (row) => {
    expect(() => resolveBackupTableSelection(['OrderItems'], [row])).toThrow();
  });
  it('rejects a changed explicit namespace and malformed catalog replies', () => {
    expect(() =>
      resolveBackupTableSelection(
        ['expected.OrderItems'],
        [{ schema: 'other', name: 'OrderItems', kind: 'r', persistence: 'p' }],
      ),
    ).toThrow();
    expect(() => resolveBackupTableSelection(['OrderItems'], [])).toThrow();
  });
  it('binds exact names and namespaces without SQL interpolation and includes descendants', () => {
    const query = backupSelectiveRestoreQuery([
      'MixedSchema.MixedTable',
      'Simple',
    ]);
    expect(query.values).toEqual([
      ['MixedTable', 'Simple'],
      ['MixedSchema', null],
    ]);
    expect(query.text).not.toContain('MixedTable');
    expect(query.text).toContain('WITH RECURSIVE');
    expect(query.query_timeout).toBe(1500);
    expect(selectiveBackupRestoreBlocked([{ blocked: false }])).toBe(false);
    expect(selectiveBackupRestoreBlocked([{ blocked: true }])).toBe(true);
  });
  it.each(
    [
      [],
      [{ blocked: null }],
      [{ blocked: 'false' }],
      [{ blocked: false, extra: 'unknown' }],
      [{ blocked: false }, { blocked: false }],
    ].map((rows) => ({ rows })),
  )('refuses an unconfirmed probe %j', ({ rows }) => {
    expect(() => selectiveBackupRestoreBlocked(rows)).toThrow(
      'BACKUP_SELECTIVE_RESTORE_PROBE_UNCONFIRMED',
    );
  });
  it.each(
    [[], ['public.bad;drop'], [' public.asins'], ['public.asins.extra']].map(
      (tables) => ({ tables }),
    ),
  )('refuses unsafe selection %j', ({ tables }) => {
    expect(() => backupSelectiveRestoreQuery(tables)).toThrow();
  });
});
