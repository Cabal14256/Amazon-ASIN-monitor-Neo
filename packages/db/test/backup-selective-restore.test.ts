import { describe, expect, it } from 'vitest';
import {
  backupSelectiveRestoreQuery,
  selectiveBackupRestoreBlocked,
} from '../src/domain/backup-selective-restore';

describe('selective backup restore catalog boundary', () => {
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
