import {
  buildScheduledMonitorJobId,
  type ScheduledMonitorPlan,
} from '@asin-monitor/contracts';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCHEDULED_MONITOR_MAX_AGE_MS,
  evaluateScheduledMonitorFreshness,
  orderScheduledMonitorGroups,
  parseScheduledMonitorJob,
  scheduledMonitorBatchIndex,
  scheduledMonitorGroupBatch,
  scheduledMonitorIdCrc32,
  scheduledMonitorJobDigest,
  scheduledMonitorTaskId,
} from '../src/domain/scheduled-monitor-policy';
import crcGolden from './fixtures/scheduled-monitor-crc32.json';

const start = Date.parse('2026-07-31T08:00:00.000Z');
const limit = DEFAULT_SCHEDULED_MONITOR_MAX_AGE_MS;
const freshCases = [
  {
    data: { source: 'scheduled', requestedAt: new Date(start).toISOString() },
    timestamp: start,
    now: start + limit - 1,
    expected: { stale: false, reason: null, ageMs: limit - 1 },
  },
  {
    data: { source: 'scheduled', requestedAt: new Date(start).toISOString() },
    timestamp: start,
    now: start + limit,
    expected: { stale: false, reason: null, ageMs: limit },
  },
  {
    data: { source: 'scheduled', requestedAt: new Date(start).toISOString() },
    timestamp: start,
    now: start + limit + 1,
    expected: {
      stale: true,
      reason: 'scheduled_job_expired',
      ageMs: limit + 1,
    },
  },
  {
    data: { source: 'scheduled' },
    timestamp: start,
    now: start + limit + 1,
    expected: {
      stale: true,
      reason: 'scheduled_job_expired',
      ageMs: limit + 1,
    },
  },
  {
    data: { source: 'scheduled', requestedAt: 'invalid' },
    timestamp: start,
    now: start + 100,
    expected: { stale: false, reason: null, ageMs: 100 },
  },
  {
    data: { source: 'scheduled' },
    timestamp: null,
    now: start,
    expected: { stale: true, reason: 'missing_requested_at', ageMs: null },
  },
  {
    data: { source: 'manual', requestedAt: new Date(start).toISOString() },
    timestamp: null,
    now: start + limit * 100,
    expected: { stale: false, reason: null, ageMs: 0 },
  },
  {
    data: {
      source: 'scheduled',
      requestedAt: new Date(start + 100).toISOString(),
    },
    timestamp: start,
    now: start,
    expected: { stale: false, reason: null, ageMs: 0 },
  },
];
const batchCases = [
  { epoch: 0, interval: 30, batches: 3, expected: 0 },
  { epoch: 30 * 60000 - 1, interval: 30, batches: 3, expected: 0 },
  { epoch: 30 * 60000, interval: 30, batches: 3, expected: 1 },
  { epoch: 90 * 60000, interval: 30, batches: 3, expected: 0 },
  { epoch: -1, interval: 30, batches: 3, expected: 2 },
  { epoch: -30 * 60000 - 1, interval: 30, batches: 3, expected: 1 },
  { epoch: start, interval: 15, batches: 1000, expected: 872 },
];

/** The actual Legacy pure helpers run untouched in a separate process. Frozen
 * expected results ensure neither a Neo nor Legacy change silently moves a gate. */
const legacy = JSON.parse(
  execFileSync(
    process.execPath,
    [
      '-e',
      `
const fs = require('node:fs');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const p = require(input.policy), b = require(input.batch);
process.stdout.write(JSON.stringify({
  fresh: input.fresh.map(c => p.evaluateScheduledJobFreshness(c.data, c.timestamp, c.now, input.limit)),
  batches: input.batches.map(c => b.calculateScheduledBatchIndex(new Date(c.epoch), c.interval, c.batches)),
  id: p.buildScheduledJobId('neo-primary-monitor', input.id),
}));
`,
    ],
    {
      input: JSON.stringify({
        policy: resolve(
          __dirname,
          '../../../server/src/services/monitorQueuePolicy.js',
        ),
        batch: resolve(__dirname, '../../../server/src/utils/monitorBatch.js'),
        fresh: freshCases,
        batches: batchCases,
        limit,
        id: {
          source: 'scheduled',
          requestedAt: '2026-10-03T12:30:59.000Z',
          countries: ['US'],
          batchConfig: { batchIndex: 0, totalBatches: 1 },
        },
      }),
      encoding: 'utf8',
    },
  ),
) as { fresh: unknown[]; batches: number[]; id: string };

const plan: ScheduledMonitorPlan = {
  domain: 'primary',
  country: 'US',
  plannedSlot: '2026-10-03T12:30:00.000Z',
  intervalMinutes: 30,
  batchConfig: { batchIndex: 0, totalBatches: 1 },
};

describe('scheduled monitor Legacy execution policy', () => {
  it.each(freshCases.map((value, index) => ({ ...value, index })))(
    'matches frozen freshness boundary %#',
    (row) => {
      expect(legacy.fresh[row.index]).toMatchObject({
        ...row.expected,
        maxAgeMs: limit,
      });
      expect(
        evaluateScheduledMonitorFreshness(row.data, row.timestamp, row.now),
      ).toMatchObject({ ...row.expected, maxAgeMs: limit });
    },
  );
  it('only uses the immutable queue timestamp when the requested timestamp cannot be trusted', () => {
    expect(
      evaluateScheduledMonitorFreshness(
        { source: 'scheduled', requestedAt: '2026-02-30T00:00:00.000Z' },
        start,
        start,
      ),
    ).toMatchObject({ stale: false, timestampSource: 'queue', ageMs: 0 });
    expect(
      evaluateScheduledMonitorFreshness(
        { source: 'scheduled', requestedAt: new Date(start).toISOString() },
        start + 999,
        start,
      ),
    ).toMatchObject({ timestampSource: 'requestedAt', ageMs: 0 });
  });
  it.each([
    null,
    undefined,
    0,
    -1,
    NaN,
    Infinity,
    start + 0.5,
    String(start),
    {},
  ])('fails closed on absent or untrusted queue time %#', (timestamp) => {
    expect(
      evaluateScheduledMonitorFreshness(
        { source: 'scheduled' },
        timestamp,
        start,
      ),
    ).toMatchObject({ stale: true, reason: 'missing_requested_at' });
  });
  it('does not grant the manual exemption to an unknown or missing source', () => {
    for (const source of [undefined, 'user-controlled', null])
      expect(
        evaluateScheduledMonitorFreshness({ source }, start, start),
      ).toMatchObject({ stale: true, reason: 'invalid_source' });
  });
  it('rejects an invalid policy clock or maximum age', () => {
    expect(() =>
      evaluateScheduledMonitorFreshness({ source: 'scheduled' }, start, NaN),
    ).toThrow(RangeError);
    expect(() =>
      evaluateScheduledMonitorFreshness(
        { source: 'scheduled' },
        start,
        start,
        0,
      ),
    ).toThrow(RangeError);
  });
  it.each(batchCases.map((value, index) => ({ ...value, index })))(
    'matches frozen Legacy slot index %#',
    (row) => {
      expect(legacy.batches[row.index]).toBe(row.expected);
      expect(
        scheduledMonitorBatchIndex(row.epoch, row.interval, row.batches),
      ).toBe(row.expected);
    },
  );
  it.each([
    [NaN, 30, 1],
    [0, 0, 1],
    [0, 30, 0],
    [0, 30, 1001],
    [0, 0.5, 1],
  ])(
    'rejects a malformed slot instead of silently selecting all groups %#',
    (epoch, interval, count) => {
      expect(() => scheduledMonitorBatchIndex(epoch, interval, count)).toThrow(
        RangeError,
      );
    },
  );
  it('preserves the Legacy minute slot and batch suffix under the Neo domain prefix', () => {
    expect(buildScheduledMonitorJobId(plan)).toBe(legacy.id);
  });
});

describe('raw canonical ID batch membership and fixed order', () => {
  it.each(crcGolden.cases)(
    'matches independent frozen unsigned CRC32 for $id',
    ({ id, crc32 }) => {
      expect(scheduledMonitorIdCrc32(id)).toBe(crc32);
      for (const count of [1, 2, 3, 17, 1000])
        expect(scheduledMonitorGroupBatch(id, count)).toBe(crc32 % count);
    },
  );
  it('retains whitespace, case and Unicode composition distinctions', () => {
    expect(
      new Set(['group-1', ' group-1 ', 'GROUP-1'].map(scheduledMonitorIdCrc32))
        .size,
    ).toBe(3);
    expect(scheduledMonitorIdCrc32('é')).not.toBe(
      scheduledMonitorIdCrc32('e\u0301'),
    );
  });
  it.each(['a\0b', '\ud800', '\udc00'])(
    'refuses text PostgreSQL cannot persist without lossy encoding %#',
    (id) => {
      expect(() => scheduledMonitorIdCrc32(id)).toThrow(TypeError);
    },
  );
  it('puts nullable create times first and resolves ties by raw UTF-8 bytes without modifying input', () => {
    const older = '2026-10-01 00:00:00',
      newer = '2026-10-02 00:00:00';
    const rows = [
      { id: 'later', createTimeNative: newer },
      { id: 'é', createTimeNative: older },
      { id: 'A', createTimeNative: older },
      { id: ' null', createTimeNative: null },
      { id: 'e\u0301', createTimeNative: older },
      { id: '0', createTimeNative: null },
    ];
    const original = [...rows];
    expect(orderScheduledMonitorGroups(rows).map((row) => row.id)).toEqual([
      ' null',
      '0',
      'A',
      'e\u0301',
      'é',
      'later',
    ]);
    expect(rows).toEqual(original);
    expect(orderScheduledMonitorGroups([...rows].reverse())).toEqual(
      orderScheduledMonitorGroups(rows),
    );
  });
  it('rejects duplicate identity or an invalid creation time before freezing a set', () => {
    expect(() =>
      orderScheduledMonitorGroups([
        { id: 'a', createTimeNative: null },
        { id: 'a', createTimeNative: null },
      ]),
    ).toThrow(TypeError);
    expect(() =>
      orderScheduledMonitorGroups([{ id: 'a', createTimeNative: 'invalid' }]),
    ).toThrow(TypeError);
  });
  it.each(['000001', '123456'])(
    'preserves a one-microsecond difference ahead of reversed IDs (%s)',
    (fraction) => {
      const next = String(Number(fraction) + 1).padStart(6, '0');
      const rows = [
        { id: 'A-later', createTimeNative: `2026-10-01 00:00:00.${next}` },
        {
          id: 'Z-earlier',
          createTimeNative: `2026-10-01 00:00:00.${fraction}`,
        },
      ];
      // Both distinct PG instants collapse to the same display Date millisecond.
      expect(
        new Date(
          rows[0].createTimeNative.replace(' ', 'T') + '+08:00',
        ).getTime(),
      ).toBe(
        new Date(
          rows[1].createTimeNative.replace(' ', 'T') + '+08:00',
        ).getTime(),
      );
      expect(orderScheduledMonitorGroups(rows).map((row) => row.id)).toEqual([
        'Z-earlier',
        'A-later',
      ]);
    },
  );
  it('compares equivalent native fractional spellings by canonical raw ID', () => {
    expect(
      orderScheduledMonitorGroups([
        { id: 'Z', createTimeNative: '2026-10-01 00:00:00.1' },
        { id: 'A', createTimeNative: '2026-10-01 00:00:00.100000' },
      ]).map((row) => row.id),
    ).toEqual(['A', 'Z']);
  });
  it.each([
    '2026-02-30 00:00:00',
    '2026-01-01 24:00:00',
    '2026-01-01 00:00:00.1234567',
  ])('rejects invalid or overprecision native text %s', (createTimeNative) => {
    expect(() =>
      orderScheduledMonitorGroups([{ id: 'a', createTimeNative }]),
    ).toThrow(TypeError);
  });
});

describe('deterministic scheduled incarnation', () => {
  it('keeps the UUID across enqueue retries and separates countries and domains', () => {
    // Independently frozen with Python uuid.uuid5 and the private namespace.
    expect(scheduledMonitorTaskId(plan)).toBe(
      'd88b8855-3ce1-530b-b5b8-56aa2eaea53a',
    );
    expect(scheduledMonitorTaskId(plan)).toBe(
      scheduledMonitorTaskId({ ...plan }),
    );
    expect(scheduledMonitorTaskId(plan)).toMatch(
      /^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/,
    );
    expect(scheduledMonitorTaskId(plan)).not.toBe(
      scheduledMonitorTaskId({ ...plan, country: 'DE' }),
    );
    expect(scheduledMonitorTaskId(plan)).not.toBe(
      scheduledMonitorTaskId({ ...plan, domain: 'competitor' }),
    );
  });
  it('binds a parsed job to its deterministic task ID as well as the stable queue identity', () => {
    const job = {
      ...plan,
      version: 1,
      source: 'scheduled',
      taskType: 'scheduled-monitor',
      actor: { kind: 'system', purpose: 'scheduled-monitor' },
      taskId: scheduledMonitorTaskId(plan),
      jobId: buildScheduledMonitorJobId(plan),
      requestedAt: '2026-10-03T12:30:01.000Z',
      createdAt: '2026-10-03T12:30:02.000Z',
      expiresAt: '2026-10-10T12:30:02.000Z',
    };
    expect(parseScheduledMonitorJob(job)).toEqual(job);
    expect(scheduledMonitorJobDigest(job)).toBe(
      scheduledMonitorJobDigest({ ...job }),
    );
    for (const change of [
      { expiresAt: '2026-10-11T12:30:02.000Z' },
      { createdAt: '2026-10-03T12:30:03.000Z' },
      { requestedAt: '2026-10-03T12:30:00.000Z' },
      { intervalMinutes: 60 },
    ])
      expect(scheduledMonitorJobDigest({ ...job, ...change })).not.toBe(
        scheduledMonitorJobDigest(job),
      );
    expect(() =>
      parseScheduledMonitorJob({
        ...job,
        taskId: 'aaaaaaaa-aaaa-5aaa-8aaa-aaaaaaaaaaaa',
      }),
    ).toThrow(TypeError);
    expect(() =>
      parseScheduledMonitorJob({ ...job, domain: 'competitor' }),
    ).toThrow();
  });
});
