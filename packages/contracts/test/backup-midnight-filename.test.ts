import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  backupCreationFilename,
  backupCreationFilenameMatches,
  backupCreationFilenames,
  backupFilenameCreatedAt,
} from '../src/domains/backup';

const taskId = '10000000-0000-4000-8000-000000000161';
const createdAt = '2026-09-01T16:00:01.123Z';
const canonical =
  'backup_20260902-000001-10000000000040008000000000000161-primary.dump';
const legacy = canonical.replace('-000001-', '-240001-');
const originalDateTimeFormat = Intl.DateTimeFormat;
afterEach(() => vi.restoreAllMocks());

/** Model an ICU h24 default while honoring an explicitly selected h23 cycle. */
function mockMidnightICU(ignoreHourCycle: boolean) {
  const calls: (Intl.DateTimeFormatOptions | undefined)[] = [];
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (
    locales,
    options,
  ) {
    calls.push(options);
    const formatter = new originalDateTimeFormat(locales, {
      ...options,
      hour12: undefined,
      hourCycle: 'h23',
    });
    const parts = formatter.formatToParts.bind(formatter);
    formatter.formatToParts = (date) =>
      parts(date).map((part) =>
        part.type === 'hour' &&
        part.value === '00' &&
        (ignoreHourCycle || options?.hourCycle !== 'h23')
          ? { ...part, value: '24' }
          : part,
      );
    return formatter;
  });
  return calls;
}

describe('deterministic Shanghai backup midnight filenames', () => {
  it('selects h23 on a host whose default hour12:false cycle is h24', () => {
    const calls = mockMidnightICU(false);
    expect(backupCreationFilename(taskId, createdAt, 'primary')).toBe(
      canonical,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ hourCycle: 'h23' });
    expect(calls[0]?.hour12).toBeUndefined();
  });

  it('normalizes a residual 24 hour without advancing its calendar date', () => {
    mockMidnightICU(true);
    expect(backupCreationFilename(taskId, createdAt, 'primary')).toBe(
      canonical,
    );
  });

  it('preserves the old h24 recovery timestamp and original date', () => {
    expect(backupFilenameCreatedAt(legacy)).toBe('2026-09-01T16:00:01.000Z');
    expect(backupFilenameCreatedAt(canonical)).toBe('2026-09-01T16:00:01.000Z');
    expect(
      backupFilenameCreatedAt(legacy.replace('20260902', '20260230')),
    ).toBeUndefined();
  });

  it('bounds compatibility to the same date, full task suffix and target without trimming', () => {
    expect(backupCreationFilenames(taskId, createdAt, 'primary')).toEqual([
      canonical,
      legacy,
    ]);
    for (const filename of [canonical, legacy])
      expect(
        backupCreationFilenameMatches(filename, taskId, createdAt, 'primary'),
      ).toBe(true);
    for (const filename of [
      ` ${legacy}`,
      `${legacy} `,
      legacy.replace('20260902', '20260903'),
      legacy.replace('00000161', '00000162'),
      legacy.replace('-primary', '-competitor'),
      legacy.replace('-240001-', '-240002-'),
      legacy.replace('10000000000040008000000000000161', '00000161'),
    ])
      expect(
        backupCreationFilenameMatches(filename, taskId, createdAt, 'primary'),
      ).toBe(false);
    expect(
      backupCreationFilenames(taskId, '2026-09-02T01:00:00.000Z', 'primary'),
    ).toEqual([
      'backup_20260902-090000-10000000000040008000000000000161-primary.dump',
    ]);
  });
});
