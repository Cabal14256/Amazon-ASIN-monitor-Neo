import { describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/client';
import {
  MonitorStatusIntervalQueryError,
  parseMonitorStatusIntervalQuery,
} from '../src/domain/monitor-status-interval-query';
import { readMonitorStatusIntervals } from '../src/repositories/monitor-status-interval-query-repository';

describe('monitor status interval query input', () => {
  it('normalizes Shanghai wall-clock bounds and bounded pagination', () => {
    expect(
      parseMonitorStatusIntervalQuery({
        country: ' eu ',
        asinId: 'asin-1',
        startTime: '2026-09-01',
        endTime: '2026-09-02 12:30:00.1',
        current: '2',
        pageSize: '25',
      }),
    ).toEqual({
      country: 'eu',
      asinId: 'asin-1',
      startTime: '2026-09-01 00:00:00',
      endTime: '2026-09-02 12:30:00.100',
      current: 2,
      pageSize: 25,
    });
  });

  it.each([
    null,
    [],
    { startTime: '2026-09-02', endTime: '2026-09-01' },
    { startTime: '2026-02-30', endTime: '2026-03-01' },
    { startTime: '2026-09-01', endTime: '2026-09-02', pageSize: '101' },
    { startTime: '2026-09-01', endTime: '2026-09-02', current: '1e3' },
    { startTime: '2026-09-01', endTime: '2026-09-02', asinId: 'x'.repeat(51) },
    { startTime: '2026-09-01', endTime: '2026-09-02', unexpected: 'x' },
  ])('rejects malformed query %#', (value) => {
    expect(() => parseMonitorStatusIntervalQuery(value)).toThrow(
      MonitorStatusIntervalQueryError,
    );
  });

  it('rejects noncanonical direct repository values', () => {
    expect(() =>
      parseMonitorStatusIntervalQuery({
        startTime: '2026-09-01 00:00:00.000',
        endTime: '2026-09-02',
        current: '1',
        pageSize: '50',
      }),
    ).not.toThrow();
  });
});

function fixture() {
  const execute = vi.fn(async () => ({
    rows: [
      {
        covered: true,
        total: '1',
        records: [
          {
            asin_key: 'B000000001',
            asin_id: 'asin-1',
            asin_code: 'B000000001',
            asin_name: 'Fixture ASIN',
            country: 'US',
            variant_group_id: 'group-1',
            variant_group_name: 'Fixture group',
            interval_start: '2026-09-01 00:00:00',
            interval_end: null,
            is_broken: true,
          },
        ],
      },
    ],
  }));
  const db = createDb({ query: execute } as never);
  const query = {
    country: 'US',
    startTime: '2026-09-01 00:00:00',
    endTime: '2026-09-02 00:00:00',
    current: 1,
    pageSize: 50,
  } as const;
  return { execute, db, query };
}

describe('monitor status interval repository result boundary', () => {
  it.each(['eu', 'Eu', 'eU'])(
    'uses the same five-country coverage proof and records for %s and EU',
    async (country) => {
      const upper = fixture();
      const lower = fixture();
      await readMonitorStatusIntervals(
        upper.db,
        { ...upper.query, country: 'EU' },
        () => {},
      );
      await readMonitorStatusIntervals(
        lower.db,
        { ...lower.query, country },
        () => {},
      );
      const lowerCall = lower.execute.mock.calls.at(-1) as unknown as [
        { text: string },
        unknown[],
      ];
      const upperCall = upper.execute.mock.calls.at(-1) as unknown as [
        { text: string },
        unknown[],
      ];
      expect(lowerCall[0].text).toBe(upperCall[0].text);
      expect(lowerCall[1]).toEqual(upperCall[1]);
    },
  );
  it('reads the default all-country window without requiring a country filter', async () => {
    const f = fixture();
    const { country: _country, ...query } = f.query;
    const result = await readMonitorStatusIntervals(f.db, query, () => {});
    expect(result.coverage).toBe('complete');
    expect(result.list[0].country).toBe('US');
    expect(f.execute).toHaveBeenCalledTimes(3);
  });

  it('returns complete rows after the coverage proof and checks connection lifetime', async () => {
    const f = fixture();
    const ensureOpen = vi.fn();
    const result = await readMonitorStatusIntervals(f.db, f.query, ensureOpen);
    expect(result).toEqual({
      list: [
        {
          asinKey: 'B000000001',
          asinId: 'asin-1',
          asinCode: 'B000000001',
          asinName: 'Fixture ASIN',
          country: 'US',
          variantGroupId: 'group-1',
          variantGroupName: 'Fixture group',
          intervalStart: '2026-09-01 00:00:00',
          intervalEnd: null,
          isBroken: true,
        },
      ],
      total: 1,
      current: 1,
      pageSize: 50,
      coverage: 'complete',
    });
    expect(f.execute).toHaveBeenCalledTimes(3);
    expect(ensureOpen).toHaveBeenCalledTimes(2);
  });

  it('returns an empty stale result without exposing unproven rows', async () => {
    const f = fixture();
    f.execute.mockResolvedValueOnce({
      rows: [{ setting: 'pg_catalog, public' }],
    });
    f.execute.mockResolvedValueOnce({ rows: [{ set_config: '' }] });
    f.execute.mockResolvedValueOnce({
      rows: [
        {
          covered: false,
          total: '999',
          records: [{ asin_key: 'must-not-leak' }],
        },
      ],
    });
    const result = await readMonitorStatusIntervals(f.db, f.query, () => {});
    expect(result).toEqual({
      list: [],
      total: 0,
      current: 1,
      pageSize: 50,
      coverage: 'stale',
    });
  });

  it('rejects malformed and oversized complete results', async () => {
    const malformed = fixture();
    malformed.execute.mockResolvedValueOnce({
      rows: [{ setting: 'pg_catalog, public' }],
    });
    malformed.execute.mockResolvedValueOnce({ rows: [{ set_config: '' }] });
    malformed.execute.mockResolvedValueOnce({
      rows: [{ covered: true, total: '1', records: [{ asin_key: '' }] }],
    });
    await expect(
      readMonitorStatusIntervals(malformed.db, malformed.query, () => {}),
    ).rejects.toMatchObject({ code: 'invalid-result' });

    const oversized = fixture();
    oversized.execute.mockResolvedValueOnce({
      rows: [{ setting: 'pg_catalog, public' }],
    });
    oversized.execute.mockResolvedValueOnce({ rows: [{ set_config: '' }] });
    oversized.execute.mockResolvedValueOnce({
      rows: [
        { covered: true, total: '1', records: ['x'.repeat(8 * 1024 * 1024)] },
      ],
    });
    await expect(
      readMonitorStatusIntervals(oversized.db, oversized.query, () => {}),
    ).rejects.toMatchObject({ code: 'too-large' });
  });
});
